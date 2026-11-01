/**
 * The pentest workbench (Phase 0, issue #327): a slim, BountyDesk-owned sandbox image carrying
 * httpx, nuclei and newman, link-joined to the target's sandbox the same way the browser probe
 * joins it (see browser-probe.ts for the full argument). It runs one allowlisted recon command
 * against the target's own in-mesh address and hands the raw tool output back to the agent as
 * untrusted evidence, nothing more.
 *
 * The non-negotiable invariant from docs/pentest-workbench.md: this is EVIDENCE ONLY. A nuclei
 * hit is a lead the agent can turn into a reproduction; it is never itself a REPRODUCED verdict.
 * This module never calls decideOutcome and never touches the oracle. That stays reproduce.ts's
 * job, fed only by the HTTP and browser oracles.
 *
 * Address discipline matches probe_target and probe_browser: the workbench always scans the
 * caller-supplied WorkbenchTargetRef (targetSandboxId + targetPort), which the MCP route resolves
 * from the session's server-held row, never from a path or host string the agent provides. The
 * agent only ever supplies a same-origin path and, for nuclei, a tag filter.
 */
import { buildMarkerCheck } from "./build-marker";
import { createSandbox, execute, getSandbox, type Sandbox } from "./daytona";
import {
  ensureSnapshotActive,
  rethrowIfAborted,
  teardownSandbox,
  throwIfAborted,
  verifyNoEgress,
} from "./provision";

/** A render is quick; a scan is not, but it is still bounded. Anything longer than this is wrong. */
const WORKBENCH_SANDBOX_TTL_MINUTES = 10;

/** Wall-clock ceiling on the one exec that drives the whole run, kept under daytona's
 * MAX_EXEC_SECONDS (300) with room for the sandbox's own per-tool timeout to fire first. */
const WORKBENCH_EXEC_TIMEOUT_SECONDS = 150;

/** The in-sandbox runner's own per-tool timeout ceiling, passed through to the params file. A
 * caller may ask for less; it may never ask for more than this. */
const MAX_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/** Caps on what crosses back from the sandbox, so a noisy scan or a target that stalls a tool
 * cannot blow up the worker's memory or a verdict row. */
const MAX_STDOUT_CHARS = 200_000;
const MAX_STDERR_CHARS = 20_000;

/** The only tools the baked image carries and the only ones this module will ever ask the runner
 * to invoke. Anything else is refused before a sandbox is even provisioned. */
const ALLOWED_TOOLS = ["httpx", "nuclei", "newman"] as const;
export type WorkbenchTool = (typeof ALLOWED_TOOLS)[number];

/** The line workbench-runner.mjs prints its one JSON result on. */
const RESULT_SENTINEL = "BOUNTYDESK_WORKBENCH_RESULT ";

const RUNNER_SCRIPT_PATH = "/opt/bountydesk/workbench-runner.mjs";
const PARAMS_PATH = "/tmp/bountydesk-workbench-params.json";

/** Baked into sandbox-images/workbench/Dockerfile. Hardcoded, not read from env, for the same
 * reason browser-probe.ts hardcodes its own marker: a value the environment could set would let
 * a repointed snapshot vouch for itself. */
const EXPECTED_WORKBENCH_BUILD_MARKER = "workbench-out-4";

export type WorkbenchProbeConfig = { snapshotId: string; imageRef: string; imageName: string };

/**
 * Enablement gate. Two independent switches both have to be on: BOUNTYDESK_WORKBENCH_ENABLED (the
 * product flag; default off, so an operator who has built and registered the image still has it
 * turned off for the agent until they decide otherwise) and the three image-identifying values
 * (the deployment configuration; unset on any environment that has not built the image at all).
 * Either one missing turns this off and every entry point returns a clean "not configured" result:
 * nothing is provisioned and probe_workbench is not even registered as a tool (see
 * app/api/mcp/publish-verdict/route.ts).
 */
export function workbenchProbeConfig(): WorkbenchProbeConfig | null {
  const enabled = process.env.BOUNTYDESK_WORKBENCH_ENABLED?.trim();
  if (enabled !== "1" && enabled?.toLowerCase() !== "true") return null;

  const snapshotId = process.env.BOUNTYDESK_WORKBENCH_SNAPSHOT?.trim();
  const imageRef = process.env.BOUNTYDESK_WORKBENCH_IMAGE_REF?.trim();
  const imageName = process.env.BOUNTYDESK_WORKBENCH_IMAGE_NAME?.trim();
  if (!snapshotId || !imageRef || !imageName) return null;
  return { snapshotId, imageRef, imageName };
}

export type WorkbenchTargetRef = {
  /** The target app's own reproduction sandbox id, server-held (the agent_session row), never
   * from the agent. The workbench sandbox link-joins this one and reaches it by sandbox id over
   * the private mesh route, exactly as browser-probe.ts does. */
  targetSandboxId: string;
  /** The port the target app answers on inside its sandbox. */
  targetPort: number;
};

export type WorkbenchRequest = {
  tool: WorkbenchTool;
  /** A same-origin path on the target, e.g. "/rest/products/search". Never a URL or host. */
  path: string;
  /** nuclei tag filter only; ignored by httpx and newman. Validated again by the runner. */
  tags?: string[];
  /** Per-tool timeout, capped at MAX_TOOL_TIMEOUT_MS regardless of what is asked for. */
  timeoutMs?: number;
};

export type WorkbenchProbeResult =
  | { ok: true; tool: WorkbenchTool; exitCode: number; stdout: string; stderr: string; truncated: boolean }
  | { ok: false; reason: string };

function targetOrigin(ref: WorkbenchTargetRef): string {
  return `http://${ref.targetSandboxId}:${ref.targetPort}`;
}

/** Same origin check probe_target and probe_browser both make: resolve `path` against the target
 * origin and compare origins, rather than pattern-matching the string. */
function isSameOriginPath(origin: string, path: string): boolean {
  if (!path.startsWith("/")) return false;
  try {
    const base = new URL(origin);
    return new URL(path, base).origin === base.origin;
  } catch {
    return false;
  }
}

type RawWorkbenchResult = { tool?: unknown; exitCode?: unknown; stdout?: unknown; stderr?: unknown };

function clampString(value: unknown, max: number): { text: string; truncated: boolean } {
  const text = typeof value === "string" ? value : "";
  return { text: text.slice(0, max), truncated: text.length > max };
}

function parseRunnerStdout(stdout: string): { exitCode: number; stdout: string; stderr: string; truncated: boolean } | null {
  // The result line can be anywhere in stdout; scan from the end so the runner's own last word
  // wins over an earlier line that happens to contain the sentinel text.
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const at = lines[i].indexOf(RESULT_SENTINEL);
    if (at === -1) continue;
    let parsed: RawWorkbenchResult;
    try {
      parsed = JSON.parse(lines[i].slice(at + RESULT_SENTINEL.length)) as RawWorkbenchResult;
    } catch {
      return null;
    }
    const outCap = clampString(parsed.stdout, MAX_STDOUT_CHARS);
    const errCap = clampString(parsed.stderr, MAX_STDERR_CHARS);
    return {
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : -1,
      stdout: outCap.text,
      stderr: errCap.text,
      truncated: outCap.truncated || errCap.truncated,
    };
  }
  return null;
}

/**
 * Provision an isolated, offline workbench sandbox link-joined to the target, run exactly one
 * allowlisted tool against exactly one same-origin path on it, and hand back the raw output.
 * Always tears the workbench sandbox down before returning, success or failure.
 *
 * This decides nothing about the report. It reports what a tool observed. The caller (the agent,
 * via probe_workbench) treats every byte of stdout/stderr as untrusted text to read, not as a
 * verdict or a signal any server-side code branches on.
 */
export async function runWorkbench(
  target: WorkbenchTargetRef,
  request: WorkbenchRequest,
  opts?: { signal?: AbortSignal },
): Promise<WorkbenchProbeResult> {
  const config = workbenchProbeConfig();
  if (!config) {
    return { ok: false, reason: "the pentest workbench is not configured for this deployment" };
  }

  if (!ALLOWED_TOOLS.includes(request.tool)) {
    return { ok: false, reason: `unsupported workbench tool: ${String(request.tool)}` };
  }

  const origin = targetOrigin(target);
  if (!isSameOriginPath(origin, request.path)) {
    return { ok: false, reason: "path must resolve to a same-origin path on the target" };
  }

  const timeoutMs = Math.min(
    typeof request.timeoutMs === "number" && request.timeoutMs > 0
      ? request.timeoutMs
      : // nuclei is rate-limited in the runner so it cannot take the target down, which makes a
        // tagged scan outlast the 60s default (seen live); give it the cap by default.
        request.tool === "nuclei"
        ? MAX_TOOL_TIMEOUT_MS
        : DEFAULT_TOOL_TIMEOUT_MS,
    MAX_TOOL_TIMEOUT_MS,
  );
  const tags =
    request.tool === "nuclei" && Array.isArray(request.tags)
      ? request.tags.filter((t) => typeof t === "string" && /^[a-z0-9-]+$/.test(t)).slice(0, 20)
      : undefined;

  const params = { tool: request.tool, targetOrigin: origin, path: request.path, timeoutMs, tags };
  // Same discipline as browser-probe.ts: the agent- or recipe-supplied path and tags ride in as
  // one opaque base64 blob the shell cannot break out of, decoded to a file the runner reads as
  // inert data. The exec command's structure stays fully server-controlled.
  const encoded = Buffer.from(JSON.stringify(params), "utf8").toString("base64");
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    return { ok: false, reason: "could not encode workbench probe parameters" };
  }
  const command =
    `printf %s '${encoded}' | base64 -d > ${PARAMS_PATH} && ` + `node ${RUNNER_SCRIPT_PATH} ${PARAMS_PATH}`;

  let sandbox: Sandbox | undefined;
  try {
    throwIfAborted(opts?.signal);
    const snapshotInfo = await ensureSnapshotActive(config.snapshotId, "pentest workbench", opts?.signal);
    throwIfAborted(opts?.signal);
    sandbox = await createSandbox(
      {
        snapshot: config.snapshotId,
        imageRef: config.imageRef,
        cpu: snapshotInfo.cpu ?? 0,
        memoryGb: snapshotInfo.mem ?? 0,
        diskGb: snapshotInfo.disk ?? 0,
        ttlMinutes: WORKBENCH_SANDBOX_TTL_MINUTES,
        labels: { "bountydesk.purpose.workbench": "1" },
      },
      // Daytona registers this snapshot under its tag, not the digest ref pinned above, so the
      // tag is passed as the one override createSandbox accepts in the digest's place, same as
      // browser-probe.ts. buildMarkerCheck below is what makes that override safe.
      config.imageName,
      { parentSandboxId: target.targetSandboxId },
    );
    throwIfAborted(opts?.signal);
    sandbox = await getSandbox(sandbox.id);

    // No tool runs until the block is proven: the whole point of the workbench is that it can
    // scan the target but reach nothing else, and that has to be a checked fact before a single
    // packet leaves the sandbox, not a config assumption.
    await verifyNoEgress(sandbox, opts?.signal);
    throwIfAborted(opts?.signal);

    const markerMatches = await buildMarkerCheck(sandbox, EXPECTED_WORKBENCH_BUILD_MARKER);
    throwIfAborted(opts?.signal);
    if (!markerMatches) {
      return { ok: false, reason: "the workbench sandbox booted the wrong build" };
    }

    const result = await execute(sandbox, command, WORKBENCH_EXEC_TIMEOUT_SECONDS);
    const parsed = parseRunnerStdout(result.result);
    if (!parsed) {
      return { ok: false, reason: "the workbench runner returned no usable result" };
    }
    return { ok: true, tool: request.tool, ...parsed };
  } catch (error) {
    rethrowIfAborted(error, opts?.signal);
    return {
      ok: false,
      reason: `workbench probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (sandbox) await teardownSandbox(sandbox.id, opts?.signal?.aborted === true);
  }
}
