/**
 * A headless-browser probe for client-side vulnerabilities (DOM/SPA XSS) that a plain HTTP fetch
 * can never see, because the bug only fires once a browser executes the target's JavaScript.
 *
 * Why a browser is dangerous, and how this contains it. A browser that runs the target's own JS
 * is an SSRF and exfiltration pivot: the page can `fetch()` anywhere, read cloud metadata, or
 * post out whatever it scraped. So the browser here never runs on the BountyDesk host, and never
 * in the same sandbox as the target. It runs in its own reproduction-grade sandbox
 * (networkBlockAll, no egress, torn down after the run) that is link-joined to the target's
 * sandbox, so the only thing it can reach is the one target app, by the target's sandbox id, over
 * a private in-group route. verifyNoEgress proves the block held before any page loads, the same
 * proof provisionTarget already makes for the target sandbox. The browser's Chromium and driver
 * are baked into that sandbox image and run fully offline (see docs/browser-probe.md); the two
 * optional outbound calls the webcmd driver can make are both disabled by env and, even if they
 * were not, are denied by networkBlockAll like any other egress.
 *
 * Why a separate sandbox, not the target's own. The run's canary must be unguessable to the
 * target. It rides in the URL fragment (never sent to the server) and lives only in this browser
 * sandbox's own memory and process arguments. A browser sharing the target's sandbox would leak
 * the canary to the target through the shared filesystem and /proc, and an adversarial target
 * could then echo it back to fake a REPRODUCED. Isolating the browser keeps the canary secret, so
 * its appearance in the observed sink can only mean the client-side sink actually executed.
 *
 * The oracle boundary. reproduce.ts's rule is that a REPRODUCED gate is read by BountyDesk's own
 * trusted code, never lifted from attacker-influenced exec stdout. That still holds here. The
 * browser sandbox is BountyDesk's own image, isolated from the target, so its stdout is trusted
 * code reporting what it rendered. The rendered DOM it hands back is attacker-influenced content,
 * exactly like the HTTP oracle's response body, and BountyDesk greps that content for the run's
 * secret canary itself. The target cannot put the canary there without the injected sink firing,
 * because it never learns the canary. runBrowserOracle below does that grep; this file never lets
 * a boolean the sandbox computed stand in for one BountyDesk computed.
 */
import { decideOutcome, type ReproductionDecision } from "@/lib/reproduction/decide";
import type { BrowserExploitLeg, BrowserExploitSink } from "@/lib/reproduction/types";

import { buildMarkerCheck } from "./build-marker";
import { createSandbox, execute, getSandbox, type Sandbox } from "./daytona";
import {
  ensureSnapshotActive,
  rethrowIfAborted,
  teardownSandbox,
  throwIfAborted,
  verifyNoEgress,
} from "./provision";

/** Our ceiling on how long a browser sandbox lives. A render is quick; anything longer is wrong. */
const BROWSER_SANDBOX_TTL_MINUTES = 10;

/** Wall-clock ceiling on the one exec that drives the whole render, including webcmd startup and
 * every navigation in the run. Passed to execute() as its own timeout, so a hung Chromium cannot
 * wedge the worker. Kept under daytona's MAX_EXEC_SECONDS (300). */
const BROWSER_EXEC_TIMEOUT_SECONDS = 120;

/** Caps on what crosses back from the sandbox, so a target that returns a huge DOM cannot blow up
 * the worker's memory or a verdict row. The DOM cap matches provision.ts's response-body ceiling
 * in spirit. */
const MAX_DOM_CHARS = 1_000_000;
const MAX_CONSOLE_CHARS = 100_000;
const MAX_DIALOG_MESSAGES = 50;
const MAX_DIALOG_MESSAGE_CHARS = 4_000;
const MAX_NAV_ERROR_CHARS = 500;

/** The line the in-sandbox driver prints its one JSON result on. Anything else on stdout (webcmd
 * daemon chatter, Chromium's dbus noise) is ignored, so the driver's output shape is the only
 * contract between the two sides. */
const RESULT_SENTINEL = "BOUNTYDESK_BROWSER_RESULT ";

/** Where browser-oracle.mjs is baked into the browser sandbox image, and where its params file is
 * written. The exec command is a fixed string built from these constants plus one opaque base64
 * argument, so nothing a caller (a recipe, or the agent through probe_browser) supplies is ever
 * spliced into the shell. */
const ORACLE_SCRIPT_PATH = "/opt/bountydesk/browser-oracle.mjs";
const PARAMS_PATH = "/tmp/bountydesk-browser-params.json";

/** The build marker baked into the browser image at build-marker.ts's MARKER_PATH, read back from
 * inside the booted sandbox to prove which image actually ran. Hardcoded here, not read from env or
 * any other mutable source: it is the trusted value the running image is checked against, and a
 * value the environment could set would let a repointed snapshot vouch for itself. A rebuilt image
 * changes this constant and the string in sandbox-images/browser/Dockerfile together. */
const EXPECTED_BROWSER_BUILD_MARKER = "browser-out-1";

/** snapshotId and imageRef enable the feature; imageName is the tag createSandbox accepts in the
 * digest ref's place (see runBrowserProbe). */
export type BrowserProbeConfig = { snapshotId: string; imageRef: string; imageName: string };

/**
 * The browser sandbox image is a separate, BountyDesk-owned snapshot (Chromium plus the webcmd
 * driver, see docs/browser-probe.md), not the target's image. Its snapshot id, digest-pinned image
 * ref, and tag image name all come from server env, never from a report or the agent. When any is
 * unset the whole feature is off: every entry point returns a clean "not configured" result, so
 * nothing is provisioned and no reproduction path changes until an operator builds the image and
 * sets these. That is the enablement gate for this feature.
 */
export function browserProbeConfig(): BrowserProbeConfig | null {
  const snapshotId = process.env.BOUNTYDESK_BROWSER_SNAPSHOT?.trim();
  const imageRef = process.env.BOUNTYDESK_BROWSER_IMAGE_REF?.trim();
  const imageName = process.env.BOUNTYDESK_BROWSER_IMAGE_NAME?.trim();
  if (!snapshotId || !imageRef || !imageName) return null;
  return { snapshotId, imageRef, imageName };
}

/** One navigation to run: a server-visible path (before `#`) and a client-only fragment (after
 * `#`). `label` is echoed back so a caller with several steps can tell them apart. */
export type BrowserStep = { label: string; path: string; hashPayload: string };

export type BrowserStepObservation = {
  label: string;
  /** True only when the page actually loaded. A navigation that never completed is not evidence
   * of anything, the same fail-closed stance the HTTP oracle takes on a non-2xx leg. */
  navigated: boolean;
  /** document.title after the page settled. The primary sink: only script can set it. */
  title: string;
  /** The serialized post-load DOM, capped. Attacker-influenced content, handed back for the
   * caller (or a human) to inspect, never trusted as a computed verdict. */
  dom: string;
  /** Concatenated console output the page produced during the run, capped. */
  consoleText: string;
  /** Whether a JavaScript dialog (alert/confirm/prompt) fired, and its messages, capped. */
  dialogFired: boolean;
  dialogMessages: string[];
  /** Why navigation did not complete, when it did not: the page.goto error, or webcmd's own
   * failure. Empty when the page loaded. Turns a bare navigated:false into a diagnosable reason. */
  navError: string;
};

export type BrowserProbeResult =
  | { ok: true; steps: BrowserStepObservation[] }
  | { ok: false; reason: string };

export type BrowserProbeTargetRef = {
  /** The target app's own reproduction sandbox id: the browser sandbox link-joins this one and
   * reaches the app by this id over the private route. Server-held, from the agent_session row or
   * the reproduction run, never from the agent. */
  targetSandboxId: string;
  /** The port the target app answers on inside its sandbox. */
  targetPort: number;
};

/** Build the target origin the browser navigates. The browser sandbox resolves the target's
 * sandbox id over the link network's DNS (proven in scripts/spike-linked-sandboxes.ts), so the
 * origin is `http://<targetSandboxId>:<port>` and nothing else is ever navigable: no egress, one
 * private peer. */
function targetOrigin(ref: BrowserProbeTargetRef): string {
  return `http://${ref.targetSandboxId}:${ref.targetPort}`;
}

/**
 * Refuse a step whose path does not resolve back onto the target origin, the same origin check
 * probe_target makes: parse `path` against the origin and compare origins, rather than pattern-
 * matching the string, so a `/\evil` that the URL parser would treat as a host is caught. The
 * fragment is deliberately not part of this: a fragment cannot change a URL's origin, and it is
 * the one place the canary is allowed to ride precisely because the browser never sends it to a
 * server.
 */
function isSameOriginPath(origin: string, path: string): boolean {
  if (!path.startsWith("/")) return false;
  try {
    const base = new URL(origin);
    return new URL(path, base).origin === base.origin;
  } catch {
    return false;
  }
}

type OracleParams = {
  targetOrigin: string;
  steps: BrowserStep[];
  navTimeoutMs: number;
  settleMs: number;
  maxDomChars: number;
  /** Playwright's page.goto waitUntil. domcontentloaded, not load: a heavy SPA never fires the full
   *  load event inside the timeout, which reported navigated:false even though the page rendered and
   *  the client-side sink ran. The oracle allowlists this, so it is safe to pass through. */
  waitUntil: "load" | "domcontentloaded" | "commit" | "networkidle";
};

/** The raw shape browser-oracle.mjs prints. Everything here is validated before use: the driver
 * runs offline and cannot be tampered with by the target, but a cast is not a check, and a
 * malformed line must fail the probe rather than be read as an empty render. */
type RawStep = {
  label?: unknown;
  navigated?: unknown;
  title?: unknown;
  dom?: unknown;
  consoleText?: unknown;
  dialogFired?: unknown;
  dialogMessages?: unknown;
  navError?: unknown;
};
type RawOracleResult = { steps?: RawStep[] };

function clampString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function normalizeObservation(label: string, raw: RawStep | undefined): BrowserStepObservation {
  const dialogMessages = Array.isArray(raw?.dialogMessages)
    ? raw.dialogMessages
        .slice(0, MAX_DIALOG_MESSAGES)
        .map((message) => clampString(message, MAX_DIALOG_MESSAGE_CHARS))
    : [];
  return {
    label,
    navigated: raw?.navigated === true,
    title: clampString(raw?.title, MAX_DIALOG_MESSAGE_CHARS),
    dom: clampString(raw?.dom, MAX_DOM_CHARS),
    consoleText: clampString(raw?.consoleText, MAX_CONSOLE_CHARS),
    dialogFired: raw?.dialogFired === true,
    dialogMessages,
    navError: clampString(raw?.navError, MAX_NAV_ERROR_CHARS),
  };
}

function parseOracleStdout(stdout: string, steps: BrowserStep[]): BrowserStepObservation[] | null {
  // The result line can be anywhere in stdout; scan from the end so the driver's own last word
  // wins over any earlier line that happens to contain the sentinel text.
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const at = line.indexOf(RESULT_SENTINEL);
    if (at === -1) continue;
    let parsed: RawOracleResult;
    try {
      parsed = JSON.parse(line.slice(at + RESULT_SENTINEL.length)) as RawOracleResult;
    } catch {
      return null;
    }
    if (!Array.isArray(parsed.steps)) return null;
    // Trust the labels this run asked for, matched by position, not labels the sandbox echoed:
    // the caller decides which step is the exploit, and a reordered or relabeled reply must not
    // silently reassign that meaning.
    return steps.map((step, index) => normalizeObservation(step.label, parsed.steps![index]));
  }
  return null;
}

/**
 * Provision an isolated, offline browser sandbox link-joined to the target, render every step in
 * it, and hand back what each render observed. Always tears the browser sandbox down before
 * returning, success or failure.
 *
 * This does not decide anything. It reports observations. runBrowserOracle applies the canary
 * check on top for a reproduction verdict; probe_browser hands the observations to the agent,
 * whose own draft still goes through the human publish_verdict gate.
 */
export async function runBrowserProbe(
  target: BrowserProbeTargetRef,
  steps: BrowserStep[],
  opts?: { signal?: AbortSignal },
): Promise<BrowserProbeResult> {
  const config = browserProbeConfig();
  if (!config) {
    return { ok: false, reason: "the browser probe is not configured for this deployment" };
  }
  if (steps.length === 0) return { ok: false, reason: "a browser probe needs at least one step" };

  const origin = targetOrigin(target);
  for (const step of steps) {
    if (!isSameOriginPath(origin, step.path)) {
      return { ok: false, reason: "each step path must resolve to a same-origin path on the target" };
    }
  }

  const params: OracleParams = {
    targetOrigin: origin,
    steps,
    navTimeoutMs: 15_000,
    // domcontentloaded plus a settle: the render is "DOM parsed" not "every subresource loaded",
    // then a pause for a client-side framework to boot and process the fragment. A DOM-XSS sink in
    // an SPA fires after the app boots, past DOMContentLoaded, so the settle is what gives it time.
    settleMs: 3_000,
    maxDomChars: MAX_DOM_CHARS,
    waitUntil: "domcontentloaded",
  };
  // Agent- or recipe-supplied strings ride in as one opaque base64 blob the shell cannot break
  // out of (the base64 alphabet has no shell metacharacters), decoded to a file the driver reads
  // as data. The exec command's structure stays fully server-controlled, honoring daytona.ts's
  // rule that nothing upstream builds an exec command from model or report output.
  const encoded = Buffer.from(JSON.stringify(params), "utf8").toString("base64");
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    return { ok: false, reason: "could not encode browser probe parameters" };
  }
  const command =
    `printf %s '${encoded}' | base64 -d > ${PARAMS_PATH} && ` +
    `node ${ORACLE_SCRIPT_PATH} ${PARAMS_PATH}`;

  let sandbox: Sandbox | undefined;
  try {
    throwIfAborted(opts?.signal);
    const snapshotInfo = await ensureSnapshotActive(config.snapshotId, "browser probe", opts?.signal);
    throwIfAborted(opts?.signal);
    sandbox = await createSandbox(
      {
        snapshot: config.snapshotId,
        imageRef: config.imageRef,
        cpu: snapshotInfo.cpu ?? 0,
        memoryGb: snapshotInfo.mem ?? 0,
        diskGb: snapshotInfo.disk ?? 0,
        ttlMinutes: BROWSER_SANDBOX_TTL_MINUTES,
        labels: { "bountydesk.purpose.browser": "1" },
      },
      // Daytona registers this snapshot under its tag, not the digest ref we pin (POST /snapshots
      // refuses a digest imageName), so assertSnapshotImage would reject the digest-exact check.
      // The tag is the one image name createSandbox may accept in the digest's place, the same
      // narrow override the target path uses. The buildMarkerCheck below is what makes it safe:
      // it must run and fail closed every time this override is exercised.
      config.imageName,
      { parentSandboxId: target.targetSandboxId },
    );
    throwIfAborted(opts?.signal);
    sandbox = await getSandbox(sandbox.id);

    // No page loads until the block is proven, exactly as provisionTarget does for the target
    // sandbox. This is what makes "the browser cannot exfiltrate" a checked fact, not a config
    // assumption, for the one sandbox that runs the target's JavaScript.
    await verifyNoEgress(sandbox, opts?.signal);
    throwIfAborted(opts?.signal);

    // A second, independent proof of image identity on top of assertSnapshotImage's control-plane
    // check (see build-marker.ts). Passing the tag as the override above removes the digest-exact
    // check, so this reads a marker baked into the image and rejects a repointed or wrong snapshot
    // before any target page loads. Fails closed: a missing or mismatched marker is a refusal.
    const markerMatches = await buildMarkerCheck(sandbox, EXPECTED_BROWSER_BUILD_MARKER);
    throwIfAborted(opts?.signal);
    if (!markerMatches) {
      return { ok: false, reason: "the browser sandbox booted the wrong build" };
    }

    const result = await execute(sandbox, command, BROWSER_EXEC_TIMEOUT_SECONDS);
    const observations = parseOracleStdout(result.result, steps);
    if (!observations) {
      return { ok: false, reason: "the browser driver returned no usable result" };
    }
    return { ok: true, steps: observations };
  } catch (error) {
    rethrowIfAborted(error, opts?.signal);
    return {
      ok: false,
      reason: `browser probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (sandbox) await teardownSandbox(sandbox.id, opts?.signal?.aborted === true);
  }
}

/** Read the run's canary out of the one sink the recipe declared. Only these sinks are checked,
 * never the whole DOM: a fragment reflected into the page as inert text lands in the serialized
 * DOM without any script running, and grepping that would call a harmless reflection a client-side
 * execution. `title` and a hooked `dialog` are both places only executed script reaches. */
function sinkContainsCanary(observation: BrowserStepObservation, sink: BrowserExploitSink, canary: string): boolean {
  if (sink === "title") return observation.title.includes(canary);
  return observation.dialogMessages.some((message) => message.includes(canary));
}

/** Per-leg detail alongside the decision, so reproduce.ts can record the same shape of evidence
 * the HTTP oracle does (which leg ran, whether the canary showed) rather than only the verdict. */
export type BrowserLegEvidence = { ranToCompletion: boolean; canaryFound: boolean };

export type BrowserOracleResult =
  | {
      ok: true;
      decision: ReproductionDecision;
      negativeControl: BrowserLegEvidence;
      exploit: BrowserLegEvidence;
    }
  | { ok: false; reason: string };

/**
 * The reproduction oracle for a client-side exploit. Renders the negative control and the exploit
 * in the isolated browser sandbox and maps them onto the same decideOutcome the HTTP oracle uses,
 * so a browser-confirmed REPRODUCED goes through the identical decision rule.
 *
 * The canary reaches the page only through each navigation's fragment (substituted by the caller),
 * so the server never sees it and, because the browser sandbox is isolated, neither does the
 * target. BountyDesk reads it back out of the declared sink here. The mapping:
 *   fixtureCompleted        = the negative control page loaded at all (the target is renderable)
 *   negativeControlCanary   = canary in the sink on the inert payload (must be false, or the
 *                             signal is dirty and the run is ANALYSIS_ONLY)
 *   exploitCanary           = canary in the sink on the executing payload (the proof)
 * A negative control that never loaded leaves fixtureCompleted false, which decideOutcome already
 * treats as ANALYSIS_ONLY, so a browser that could not reach the target never yields a verdict.
 */
export async function runBrowserOracle(
  target: BrowserProbeTargetRef,
  leg: BrowserExploitLeg,
  canary: string,
  opts?: { signal?: AbortSignal },
): Promise<BrowserOracleResult> {
  const substitute = (nav: { path: string; hashPayload: string }): BrowserStep => ({
    label: nav === leg.exploit ? "exploit" : "negative-control",
    path: nav.path,
    hashPayload: nav.hashPayload.split("{{canary}}").join(canary),
  });

  const probe = await runBrowserProbe(target, [substitute(leg.negativeControl), substitute(leg.exploit)], opts);
  if (!probe.ok) return probe;

  const [negativeControl, exploit] = probe.steps;
  const negCanaryFound = sinkContainsCanary(negativeControl, leg.sink, canary);
  const exploitCanaryFound = sinkContainsCanary(exploit, leg.sink, canary);
  const decision = decideOutcome({
    fixtureCompleted: negativeControl.navigated,
    negativeControlCompleted: negativeControl.navigated,
    negativeControlCanaryFound: negCanaryFound,
    exploitCompleted: exploit.navigated,
    exploitCanaryFound,
  });
  return {
    ok: true,
    decision,
    negativeControl: { ranToCompletion: negativeControl.navigated, canaryFound: negCanaryFound },
    exploit: { ranToCompletion: exploit.navigated, canaryFound: exploitCanaryFound },
  };
}
