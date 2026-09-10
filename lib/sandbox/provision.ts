/**
 * Provisioning: turning an authorized target profile into a booted, verified, reachable
 * sandbox. This is steps 1-8 of what used to be one function inside reproduce.ts -- authorize
 * (done by the caller), pick the image ref, boot from the pinned snapshot, verify egress is
 * blocked, verify the build identity, and wait for the app to answer its own port. It stops
 * there: the fixture/negative-control/exploit oracle logic is reproduce.ts's alone, and this
 * file has no notion of a canary or a recipe. Two callers need exactly this and nothing more:
 * reproduce.ts's own createReproducer, and lib/analysis/trueforge-driver.ts, which provisions a
 * target before starting the agent's turn so probe_target (lib/mcp/probe-target.ts)
 * has something reachable to forward to.
 *
 * This module deliberately does not call getPortPreviewUrl for the caller: a live preview URL
 * is exported here (used by reproduce.ts right after provisioning succeeds, and by probe_target
 * on every single call it handles), but neither of those callers wants a token stashed in this
 * function's return value. reproduce.ts needs the token in hand for the oracle's three legs, and
 * probe_target refuses to store one at all, precisely because a stored token can go stale
 * between when it's minted and when the agent finally calls the tool -- see that route's own
 * comment. So getPortPreviewUrl is called fresh, by whoever actually needs the token, every time.
 */
import { requireSecret } from "@/lib/env";
import { isValidImageDigest } from "@/lib/targets/validation";
import { buildMarkerCheck } from "./build-marker";
import { createSandbox, deleteSandbox, execute, getSandbox, getSnapshot, type Sandbox } from "./daytona";

const DAYTONA_API = "https://app.daytona.io/api";

/**
 * Ceiling on how long a fresh sandbox gets to boot before this gives up and reports
 * ANALYSIS_ONLY. Generous because a cold Daytona sandbox pull can take a while, short enough
 * that a hung boot cannot wedge a reproduction run indefinitely.
 *
 * Env-overridable, not a function parameter: ReproduceFn's signature is shared with the
 * driver and recipe pieces of Track B and isn't ours to widen. reproduce.test.ts overrides
 * both to a few milliseconds so its never-ready case doesn't sit through a real 90s wait.
 */
export function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const READINESS_TIMEOUT_MS = positiveIntegerEnv("BOUNTYDESK_REPRODUCE_READINESS_TIMEOUT_MS", 90_000);
const READINESS_POLL_MS = positiveIntegerEnv("BOUNTYDESK_REPRODUCE_READINESS_POLL_MS", 3_000);

/** Wall-clock ceiling on each direct HTTP call this process makes to Daytona's control plane. */
const HTTP_TIMEOUT_MS = 15_000;

/** Shared with probe_target (lib/mcp/probe-target.ts) and reproduce.ts's own
 * sendToSandbox: every direct HTTP call this process makes to the sandbox itself, not just to
 * Daytona's control plane, reads its response through the same cap. */
export const MAX_RESPONSE_BODY_BYTES = 1_000_000;

export class ResponseBodyTooLarge extends Error {
  constructor(limit: number) {
    super(`sandbox response exceeded ${limit} bytes`);
    this.name = "ResponseBodyTooLarge";
  }
}

/** Read a Response body up to `limitBytes`, throwing ResponseBodyTooLarge and cancelling the
 * stream rather than buffering an unbounded reply from a target this process doesn't control. */
export async function readLimitedText(response: Response, limitBytes = MAX_RESPONSE_BODY_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseBodyTooLarge(limitBytes);
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

/** Our ceiling on how long a reproduction sandbox lives, same order of magnitude as the spike
 * script's. Short: a run either finishes in a couple of minutes or something is wrong. */
const SANDBOX_TTL_MINUTES = 10;

export class ProvisionCouldNotDeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionCouldNotDeployError";
  }
}

export class ProvisionTargetUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionTargetUnavailableError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function imageRefForProfile(imageName: string, imageDigest: string): string {
  if (!isValidImageDigest(imageDigest)) {
    throw new Error(`not a valid image digest: ${imageDigest}`);
  }
  return `${imageName}@${imageDigest}`;
}

function assertSafeMeshStartCommand(service: string, value: string): void {
  if (value.length === 0 || value.length > 1_000 || /[\r\n]/.test(value)) {
    throw new ProvisionCouldNotDeployError(`mesh service ${service} has an invalid start command`);
  }
  const head = (value.trim().split(/\s+/, 1)[0] ?? "").split("/").pop()?.toLowerCase() ?? "";
  if (/^(docker|docker-compose|podman|nerdctl)$/.test(head) || /(?:^|[;&|]\s*)(?:docker|docker-compose|podman|nerdctl)\s/.test(value)) {
    throw new ProvisionCouldNotDeployError(`mesh service ${service} has a host-level start command`);
  }
}

export function timeoutSignal(outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("operation aborted");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

export function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
  if (error instanceof DOMException && error.name === "AbortError") throw error;
  if (error instanceof Error && error.name === "AbortError") throw error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type PortPreviewUrl = { url: string; token: string };

/**
 * Ask Daytona's control plane for a token-gated URL onto one port of a non-public sandbox.
 * `public: false` never changes on the sandbox itself; this URL is reachable only with the
 * token it comes back with.
 */
export async function getPortPreviewUrl(
  sandboxId: string,
  port: number,
  signal?: AbortSignal,
): Promise<PortPreviewUrl> {
  const response = await fetch(
    `${DAYTONA_API}/sandbox/${encodeURIComponent(sandboxId)}/ports/${port}/preview-url`,
    {
      headers: { authorization: `Bearer ${requireSecret("DAYTONA_API_KEY")}` },
      signal: timeoutSignal(signal),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`preview-url lookup for sandbox ${sandboxId} port ${port} -> ${response.status} ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as Partial<PortPreviewUrl>;
  if (typeof data.url !== "string" || typeof data.token !== "string") {
    throw new Error(`preview-url response for sandbox ${sandboxId} port ${port} carries no url or token`);
  }
  return { url: data.url, token: data.token };
}

/**
 * Poll the sandbox from inside until its app port answers, or give up.
 *
 * This is one of the two places execute() is allowed to gate anything here: a boot check,
 * matching AGENTS.md's "READY means the target started and answered its health check". The
 * status code is read only to decide whether to keep polling, never fed into an oracle.
 *
 * `signal` is checked between poll attempts, not inside a single execute() call: a caller
 * that cancels mid-probe still waits out that one in-flight command, but never starts another.
 */
async function waitForAppReady(
  sandbox: Sandbox,
  port: number,
  readinessPath: string,
  startCommand: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (startCommand) {
    // A server start command runs in the foreground and never returns, so waiting for it to exit
    // would always time out. Launch it detached in its own session (setsid) and background it, so
    // it outlives this exec, then let the readiness poll below decide whether it actually came up.
    // A start command that fails to bind leaves the port unanswered, which the poll reports as a
    // timeout with the app's log, so the failure is still visible.
    const escaped = startCommand.replace(/'/g, "'\\''");
    // </dev/null detaches stdin too, so nothing the app inherits is still tied to this exec's
    // channel and the process is not signalled when the exec returns.
    await execute(
      sandbox,
      `setsid sh -c '${escaped}' </dev/null >/tmp/bountydesk-app.log 2>&1 & echo launched`,
      10,
    );
  }

  const deadline = Date.now() + timeoutMs;
  const probePath = readinessPath.startsWith("/") ? readinessPath : `/${readinessPath}`;
  const tool = await httpProbeTool(sandbox, signal);
  if (!tool) {
    throw new Error(
      `sandbox ${sandbox.id} has neither curl nor wget, so app readiness cannot be checked`,
    );
  }
  // 127.0.0.1, not localhost: on some base images localhost resolves to ::1 first, and a target
  // that binds 0.0.0.0 (IPv4) is then unreachable over IPv6 and reads as never-ready. The IPv4
  // literal reaches the common 0.0.0.0 bind directly.
  const url = `http://127.0.0.1:${port}${probePath}`;
  // wget has no per-request status readout as portable as curl's -w, so a clean fetch counts as
  // ready and anything else as not-yet: the loop only needs to know the app answered.
  const probe =
    tool === "curl"
      ? `curl -s -o /dev/null -w '%{http_code}' ${url} 2>/dev/null || echo 000`
      : `wget -q -O /dev/null -T 5 ${url} 2>/dev/null && echo 200 || echo 000`;

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const result = await execute(sandbox, probe, 10);
    const status = result.result.trim();
    if (/^2\d\d$/.test(status)) return;
    await delay(READINESS_POLL_MS, signal);
  }

  // A verbose probe distinguishes the two ways readiness fails: a connection error means the app
  // is not listening (it never bound or did not survive), while an HTTP status shows it answered
  // but not with a 2xx on this path. The app log tail catches a crash message either way.
  const diag = startCommand
    ? (
        await execute(
          sandbox,
          `wget -S -O /dev/null -T 5 ${url} 2>&1 | head -4; echo "-- log: $(tail -c 250 /tmp/bountydesk-app.log 2>/dev/null | tr '\\n' ' ')"`,
          15,
        )
      ).result.trim()
    : "";
  throw new Error(
    `sandbox ${sandbox.id} did not answer on port ${port} within ${timeoutMs}ms` +
      (diag ? `; ${diag}` : ""),
  );
}

/**
 * The other place execute() is allowed to gate anything: confirming the sandbox's own network
 * policy actually blocks egress, before the app starts or anything else touches it.
 */
async function verifyNoEgress(sandbox: Sandbox, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!sandbox.networkBlockAll) {
    throw new Error("reproduction sandbox came up with networkBlockAll false");
  }
  if (sandbox.networkAllowList || sandbox.domainAllowList) {
    throw new Error("reproduction sandbox came up with a non-empty egress allow list");
  }

  // The probe needs an HTTP client inside the target image. curl is preferred, but minimal
  // bases (busybox, alpine) ship wget instead, so it is accepted as a fallback. With neither
  // the probe cannot run, and we refuse to certify rather than assume the block held.
  const tool = await httpProbeTool(sandbox, signal);
  if (!tool) {
    throw new Error(
      "neither curl nor wget is available in the sandbox, so the egress probes prove nothing",
    );
  }

  // IP literals only, deliberately: networkBlockAll blocks DNS resolution too, not just the
  // HTTP(S) request itself, so a by-hostname probe never reaches the interception proxy at
  // all. An IP literal skips DNS entirely and reaches the proxy directly, which is what
  // actually answers with the "Internet is restricted" 403 this loop checks for.
  const probes = [
    "http://1.1.1.1",
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  ];

  for (const url of probes) {
    throwIfAborted(signal);
    const probe = await runEgressProbe(sandbox, tool, url);
    throwIfAborted(signal);
    const verdict = classifyEgressProbe(probe);
    if (verdict === "blocked") continue;
    if (verdict === "reached") {
      throw new Error(`reproduction sandbox reached ${url} despite networkBlockAll`);
    }
    // Neither a proven block nor a proven reach: fail closed rather than certify no egress.
    throw new Error(
      `egress probe for ${url} was inconclusive (${tool}): ${probe.detail.slice(0, 200)}`,
    );
  }
}

async function httpProbeTool(
  sandbox: Sandbox,
  signal?: AbortSignal,
): Promise<"curl" | "wget" | null> {
  const found = await execute(
    sandbox,
    "if command -v curl >/dev/null 2>&1; then echo TOOL=curl; " +
      "elif command -v wget >/dev/null 2>&1; then echo TOOL=wget; else echo TOOL=none; fi",
    15,
  );
  throwIfAborted(signal);
  if (found.result.includes("TOOL=curl")) return "curl";
  if (found.result.includes("TOOL=wget")) return "wget";
  return null;
}

export type EgressProbeResult = {
  tool: "curl" | "wget";
  exitCode: number;
  status: string | null;
  body: string;
  stderr: string;
  detail: string;
};

async function runEgressProbe(
  sandbox: Sandbox,
  tool: "curl" | "wget",
  url: string,
): Promise<EgressProbeResult> {
  if (tool === "curl") {
    const script = [
      ": > /tmp/bountydesk-egress.body",
      `curl -sS --max-time 8 -o /tmp/bountydesk-egress.body -w '%{http_code}' '${url}' > /tmp/bountydesk-egress.status 2>/tmp/bountydesk-egress.err`,
      "echo \"PROBE exit=$? status=$(cat /tmp/bountydesk-egress.status)\"",
      "echo \"BODY $(head -c 120 /tmp/bountydesk-egress.body | tr -d '\\n')\"",
    ].join("; ");
    const result = await execute(sandbox, script, 20);
    const parsed = /PROBE exit=(\d+) status=(\d*)/.exec(result.result);
    if (!parsed) {
      throw new Error(
        `egress probe did not run (exit ${result.exitCode}): ${result.result.slice(0, 200)}`,
      );
    }
    const status = parsed[2] === "" || parsed[2] === "000" ? null : parsed[2];
    const body = /BODY (.*)/.exec(result.result)?.[1]?.trim() ?? "";
    return { tool, exitCode: Number(parsed[1]), status, body, stderr: "", detail: result.result };
  }

  // wget, deliberately without -q: the "403 Forbidden" server-error line then reaches stderr on
  // both busybox and GNU wget, which is the proof the interception proxy denied the request.
  const script = [
    ": > /tmp/bountydesk-egress.body",
    `wget -T 8 -O /tmp/bountydesk-egress.body '${url}' 2>/tmp/bountydesk-egress.err`,
    "echo \"PROBE exit=$?\"",
    "echo \"ERR $(head -c 200 /tmp/bountydesk-egress.err | tr -d '\\n')\"",
    "echo \"BODY $(head -c 120 /tmp/bountydesk-egress.body | tr -d '\\n')\"",
  ].join("; ");
  const result = await execute(sandbox, script, 20);
  const parsed = /PROBE exit=(\d+)/.exec(result.result);
  if (!parsed) {
    throw new Error(
      `egress probe did not run (exit ${result.exitCode}): ${result.result.slice(0, 200)}`,
    );
  }
  const stderr = /ERR (.*)/.exec(result.result)?.[1]?.trim() ?? "";
  const body = /BODY (.*)/.exec(result.result)?.[1]?.trim() ?? "";
  return { tool, exitCode: Number(parsed[1]), status: null, body, stderr, detail: result.result };
}

/**
 * Decide what one egress probe proved. Pure, so the security logic is unit-tested without a
 * live sandbox. `blocked` is the only pass: positive proof the interception proxy denied the
 * request (its 403 plus the "Internet is restricted" body for curl, its 403 server-error line
 * or that body for wget). `reached` means the probe got through to a real service, which fails
 * the check. `inconclusive` means neither was established, and the caller fails closed. Open
 * egress can never read as `blocked`: a real answer is a 2xx (curl status, or wget exit 0),
 * both of which fall through to `reached`.
 */
export function classifyEgressProbe(
  probe: Pick<EgressProbeResult, "tool" | "exitCode" | "status" | "body" | "stderr">,
): "blocked" | "reached" | "inconclusive" {
  const denial = "Internet is restricted";
  if (probe.tool === "curl") {
    if (probe.status === "403" && probe.body.includes(denial)) return "blocked";
    return "reached";
  }
  if (probe.exitCode === 0) return "reached";
  if (
    /(?:^|\D)403(?:\D|$)/.test(probe.stderr) ||
    /forbidden/i.test(probe.stderr) ||
    probe.body.includes(denial)
  ) {
    return "blocked";
  }
  return "inconclusive";
}

/**
 * Best-effort delete, matching the abort-aware swallow-or-surface rule every caller in this
 * codebase that tears down a sandbox needs: mid-cancellation, a delete failure is logged and
 * swallowed, because the cancellation reason is what the caller's promise must reject with, not
 * a secondary cleanup failure. Outside cancellation, a delete failure is the loudest true thing
 * this function can report, so it throws -- an orphaned sandbox is worth surfacing, never worth
 * silently swallowing into a result that looks like an ordinary verdict.
 */
export async function teardownSandbox(sandboxId: string, cancellationInFlight: boolean): Promise<void> {
  await deleteSandbox(sandboxId).catch((error) => {
    if (cancellationInFlight) {
      console.error(
        `failed to delete sandbox ${sandboxId} after cancellation: ${errorMessage(error)}`,
      );
      return;
    }
    throw new Error(`failed to delete reproduction sandbox ${sandboxId}: ${errorMessage(error)}`, {
      cause: error,
    });
  });
}

export type ProvisionAuthorization = {
  imageName: string;
  imageDigest: string;
  snapshotId: string;
  targetProfileId: string;
  readinessPath: string;
  expectedBuildMarker: string;
  startCommand?: string;
  snapshotImageRefOverride?: string;
  /** Extra seconds added to the readiness deadline for an image that starts a bundled datastore
   * before the app answers, or a slow runtime. Absent for a plain app that answers at once. */
  warmupSeconds?: number;
  /** Only present when a reproduction recipe is driving this run; threaded onto the sandbox's
   * labels for audit, same as before this function existed on its own. The driver's turn-time
   * provisioning has no recipe and leaves this unset. */
  recipeId?: string;
};

/**
 * Provision one reproduction-grade sandbox from an already-authorized target: pick the image
 * ref, boot from the pinned snapshot, verify egress is blocked, verify the build identity, and
 * wait for the app to answer its own port. Throws ProvisionCouldNotDeployError or
 * ProvisionTargetUnavailableError on failure -- the caller decides what that means for its own
 * result type (an ANALYSIS_ONLY reason for reproduce.ts, a plain turn-message fallback for the
 * driver) -- or the original abort reason, unwrapped, when the caller's signal fired.
 *
 * A sandbox that comes up only to fail a later check (egress, build marker, readiness) is torn
 * down here, before this function returns control to its caller: nothing is left dangling for a
 * caller who only ever learns about a *successful* provision to have to clean up. A sandbox this
 * function hands back on success is the caller's to tear down once the run that needed it is
 * over.
 */
export async function provisionTarget(
  authorization: ProvisionAuthorization,
  appPort: number,
  opts?: { signal?: AbortSignal },
): Promise<{ sandboxId: string; appPort: number }> {
  throwIfAborted(opts?.signal);

  let imageRef: string;
  try {
    imageRef = imageRefForProfile(authorization.imageName, authorization.imageDigest);
  } catch (error) {
    rethrowIfAborted(error, opts?.signal);
    throw new ProvisionCouldNotDeployError(errorMessage(error));
  }

  let sandbox: Sandbox | undefined;
  try {
    const snapshotInfo = await getSnapshot(authorization.snapshotId);
    throwIfAborted(opts?.signal);
    sandbox = await createSandbox(
      {
        snapshot: authorization.snapshotId,
        imageRef,
        // Matched to the snapshot's own declared limits, the same way scripts/spike-daytona.ts
        // does it: createSandbox refuses to request resources of its own, so these are read
        // back from the snapshot record and createSandbox re-verifies them before it provisions.
        cpu: snapshotInfo.cpu ?? 0,
        memoryGb: snapshotInfo.mem ?? 0,
        diskGb: snapshotInfo.disk ?? 0,
        ttlMinutes: SANDBOX_TTL_MINUTES,
        labels: {
          ...(authorization.recipeId ? { "bountydesk.recipe": authorization.recipeId } : {}),
          "bountydesk.targetProfileId": authorization.targetProfileId,
        },
      },
      // The narrow, explicitly-named exception documented on assertSnapshotImage: today's
      // registered snapshot can only be tag-pinned (see that function's doc comment), so this
      // is the one tag createSandbox is allowed to accept in the digest's place. The
      // buildMarkerCheck call below is what makes that safe to do -- it must run, and it must
      // fail closed, every single time this override is exercised.
      authorization.snapshotImageRefOverride,
    );
    throwIfAborted(opts?.signal);
    sandbox = await getSandbox(sandbox.id);
  } catch (error) {
    if (sandbox) await teardownSandbox(sandbox.id, opts?.signal?.aborted === true);
    rethrowIfAborted(error, opts?.signal);
    throw new ProvisionCouldNotDeployError(errorMessage(error));
  }

  throwIfAborted(opts?.signal);

  try {
    await verifyNoEgress(sandbox, opts?.signal);

    // A second, independent proof of build identity (see build-marker.ts), on top of
    // assertSnapshotImage's control-plane check that createSandbox already ran above. This
    // reads a marker from the booted image before the target application starts, so a
    // mismatched tag-pinned snapshot cannot execute target code before being rejected.
    const markerMatches = await buildMarkerCheck(sandbox, authorization.expectedBuildMarker);
    throwIfAborted(opts?.signal);
    if (!markerMatches) {
      throw new Error(`sandbox ${sandbox.id} booted the wrong build`);
    }
  } catch (error) {
    await teardownSandbox(sandbox.id, opts?.signal?.aborted === true);
    rethrowIfAborted(error, opts?.signal);
    throw new ProvisionCouldNotDeployError(errorMessage(error));
  }

  try {
    await waitForAppReady(
      sandbox,
      appPort,
      authorization.readinessPath,
      authorization.startCommand,
      READINESS_TIMEOUT_MS + Math.max(0, authorization.warmupSeconds ?? 0) * 1000,
      opts?.signal,
    );
  } catch (error) {
    await teardownSandbox(sandbox.id, opts?.signal?.aborted === true);
    rethrowIfAborted(error, opts?.signal);
    throw new ProvisionTargetUnavailableError(errorMessage(error));
  }

  return { sandboxId: sandbox.id, appPort };
}

/** One service of a compose-mesh, as the reproduction path sees it: the pinned image and snapshot to
 *  boot, and the details needed to start it and wire it to its peers. */
export type MeshServiceAuth = {
  service: string;
  role: "app" | "dependency";
  imageName: string;
  imageDigest: string;
  snapshotId: string;
  snapshotImageRefOverride?: string;
  /** Absent for a background worker with no inbound port. */
  port?: number;
  /** Present for a service we built; its identity is re-proven from inside before it runs. */
  buildMarker?: string;
  /** The command that starts a built service, whose image entrypoint was overridden to idle. Absent
   *  for a pulled dependency, which auto-starts from its own entrypoint. */
  startCommand?: string;
  /** Compose service names this service connects to, resolved to peer sandbox ids at wiring time. */
  peers?: string[];
};

export type MeshProvisionAuthorization = {
  targetProfileId: string;
  appService: string;
  services: MeshServiceAuth[];
  readinessPath: string;
  warmupSeconds?: number;
  recipeId?: string;
};

/**
 * The shell that maps each compose service name to its peer's link ip in /etc/hosts. A linked
 * sandbox resolves a peer by its sandbox id over the link network's DNS (proven in
 * scripts/spike-linked-sandboxes.ts); this looks that up and writes "<ip> <service-name>" so the
 * compose service name the app baked in (a DB host set to "db") resolves to the db sandbox. Pure,
 * so the wiring is unit-tested without a live sandbox.
 */
export function peerHostsCommand(peers: Array<{ name: string; sandboxId: string }>): string {
  if (peers.length === 0) return "";
  return (
    peers
      .map(
        (p) =>
          `ip=$(getent hosts ${shArg(p.sandboxId)} | awk '{print $1}'); ` +
          `if [ -z "$ip" ]; then echo 'peer lookup failed' >&2; exit 1; fi; ` +
          `echo "$ip ${p.name}" >> /etc/hosts`,
      )
      .join("; ") + "; echo BOUNTYDESK_PEERS_OK"
  );
}

function shArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Provision a compose-mesh: the app service as the parent sandbox and each dependency as a linked
 * child, all internet-blocked. The app is what probe_target reaches; a dependency is internal.
 *
 * The order is deliberate. The app boots first (a child links to a parent, so the parent must exist)
 * with its entrypoint idle so it does not start before its peers are reachable. Then every node is
 * proven internet-closed (verify the graph: one leaky node fails the whole mesh closed) and every
 * built node is proven to be the build we expect. Then each sandbox's /etc/hosts is wired so a
 * compose service name resolves to its peer. Only then are built dependencies started, their ports
 * waited on, and finally the app started and waited on. A failure at any step tears the whole group
 * down before returning.
 */
export async function provisionMesh(
  auth: MeshProvisionAuthorization,
  opts?: { signal?: AbortSignal },
): Promise<{ sandboxId: string; appPort: number; sandboxIds: string[] }> {
  throwIfAborted(opts?.signal);
  const names = new Set<string>();
  for (const service of auth.services) {
    if (!service.service || names.has(service.service)) {
      throw new ProvisionCouldNotDeployError("compose-mesh has duplicate or empty service names");
    }
    names.add(service.service);
  }
  const apps = auth.services.filter((service) => service.role === "app");
  const app = apps[0];
  if (apps.length !== 1 || !app || app.service !== auth.appService || app.port === undefined) {
    throw new ProvisionCouldNotDeployError("compose-mesh must have exactly one named app service with a port");
  }
  for (const service of auth.services) {
    for (const peer of service.peers ?? []) {
      if (!names.has(peer)) {
        throw new ProvisionCouldNotDeployError(`compose-mesh service ${service.service} references unknown peer ${peer}`);
      }
    }
    if (service.startCommand) assertSafeMeshStartCommand(service.service, service.startCommand);
  }

  const created: Array<{ service: string; sandbox: Sandbox }> = [];
  const idByService = new Map<string, string>();
  const sandboxOf = (service: string): Sandbox => {
    const found = created.find((c) => c.service === service);
    if (!found) throw new Error(`mesh service ${service} was not provisioned`);
    return found.sandbox;
  };
  const replaceCreatedSandbox = (service: string, sandbox: Sandbox): void => {
    const found = created.find((c) => c.service === service);
    if (!found) throw new Error(`mesh service ${service} was not provisioned`);
    found.sandbox = sandbox;
  };
  const teardownAll = async (): Promise<unknown[]> => {
    const errors: unknown[] = [];
    for (const c of [...created].reverse()) {
      try {
        await teardownSandbox(c.sandbox.id, opts?.signal?.aborted === true);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };

  try {
    // 1. App (parent) first, then each dependency linked to it. Register each id immediately after
    // createSandbox returns, before the follow-up inspection can fail and otherwise orphan it.
    const appSandbox = await bootMeshService(app, undefined, auth, opts?.signal, (sandbox) => {
      created.push({ service: app.service, sandbox });
      idByService.set(app.service, sandbox.id);
    }, (sandbox) => replaceCreatedSandbox(app.service, sandbox));
    for (const dep of auth.services.filter((s) => s.role !== "app")) {
      await bootMeshService(dep, appSandbox.id, auth, opts?.signal, (sandbox) => {
        created.push({ service: dep.service, sandbox });
        idByService.set(dep.service, sandbox.id);
      }, (sandbox) => replaceCreatedSandbox(dep.service, sandbox));
    }

    // 2. Verify the graph: every node blocks egress, every built node is the build we expect.
    for (const c of created) {
      throwIfAborted(opts?.signal);
      await verifyNoEgress(c.sandbox, opts?.signal);
      const svc = auth.services.find((s) => s.service === c.service)!;
      if (svc.buildMarker) {
        const ok = await buildMarkerCheck(c.sandbox, svc.buildMarker);
        throwIfAborted(opts?.signal);
        if (!ok) throw new Error(`mesh service ${c.service} booted the wrong build`);
      }
    }

    // 3. Wire /etc/hosts so a compose service name resolves to its peer's link ip.
    for (const c of created) {
      const svc = auth.services.find((s) => s.service === c.service)!;
      const peerNames = svc.peers ?? [];
      const peers = peerNames.map((name) => {
        const sandboxId = idByService.get(name);
        if (!sandboxId) throw new Error(`mesh peer ${name} for ${c.service} was not provisioned`);
        return { name, sandboxId };
      });
      if (peers.length) {
        const wiring = await execute(c.sandbox, peerHostsCommand(peers), 20);
        if (wiring.exitCode !== 0 || !wiring.result.includes("BOUNTYDESK_PEERS_OK")) {
          throw new Error(`mesh service ${c.service} could not wire its peers`);
        }
      }
    }

    // 4. Start built dependencies (a pulled datastore already auto-started from its own entrypoint).
    for (const dep of auth.services.filter((s) => s.role !== "app" && s.startCommand)) {
      await launchMeshService(sandboxOf(dep.service), dep.startCommand!);
    }
    // 5. Wait for every dependency that has a port to be listening before the app connects.
    for (const dep of auth.services.filter((s) => s.role !== "app" && s.port !== undefined)) {
      await waitForPortListening(sandboxOf(dep.service), dep.port!, opts?.signal);
    }
    // 6. Start the app and wait for it to answer its own port.
    await waitForAppReady(
      appSandbox,
      app.port,
      auth.readinessPath,
      app.startCommand,
      READINESS_TIMEOUT_MS + Math.max(0, auth.warmupSeconds ?? 0) * 1000,
      opts?.signal,
    );

    return { sandboxId: appSandbox.id, appPort: app.port, sandboxIds: created.map((c) => c.sandbox.id) };
  } catch (error) {
    const cleanupErrors = await teardownAll();
    rethrowIfAborted(error, opts?.signal);
    if (cleanupErrors.length) {
      throw new ProvisionTargetUnavailableError(
        `${errorMessage(error)}; mesh cleanup failed: ${cleanupErrors.map(errorMessage).join("; ")}`,
      );
    }
    if (error instanceof ProvisionCouldNotDeployError || error instanceof ProvisionTargetUnavailableError) {
      throw error;
    }
    throw new ProvisionTargetUnavailableError(errorMessage(error));
  }
}

/** Boot one mesh service from its pinned snapshot. A dependency passes the app's sandbox id as its
 *  link parent; the app passes none. Every egress and identity check is the single-image path's. */
async function bootMeshService(
  svc: MeshServiceAuth,
  parentSandboxId: string | undefined,
  auth: MeshProvisionAuthorization,
  signal: AbortSignal | undefined,
  onCreated: (sandbox: Sandbox) => void,
  onInspected: (sandbox: Sandbox) => void,
): Promise<Sandbox> {
  const imageRef = imageRefForProfile(svc.imageName, svc.imageDigest);
  // A snapshot the build step just created can still be materialising ("pulling"); the mesh boots
  // several of them right after a build, so wait for this one to go active rather than failing the
  // whole run on a race the next attempt would just retry.
  let snapshotInfo = await getSnapshot(svc.snapshotId);
  const activeDeadline = Date.now() + 180_000;
  while (snapshotInfo.state !== "active" && Date.now() < activeDeadline) {
    if (["error", "build_failed"].includes(snapshotInfo.state)) {
      throw new Error(`snapshot ${svc.snapshotId} for ${svc.service} is ${snapshotInfo.state}`);
    }
    await delay(3000, signal);
    snapshotInfo = await getSnapshot(svc.snapshotId);
  }
  throwIfAborted(signal);
  if (snapshotInfo.state !== "active") {
    throw new Error(`snapshot ${svc.snapshotId} for ${svc.service} did not become active`);
  }
  const sandbox = await createSandbox(
    {
      snapshot: svc.snapshotId,
      imageRef,
      cpu: snapshotInfo.cpu ?? 0,
      memoryGb: snapshotInfo.mem ?? 0,
      diskGb: snapshotInfo.disk ?? 0,
      ttlMinutes: SANDBOX_TTL_MINUTES,
      labels: {
        ...(auth.recipeId ? { "bountydesk.recipe": auth.recipeId } : {}),
        "bountydesk.targetProfileId": auth.targetProfileId,
        "bountydesk.meshService": svc.service,
      },
    },
    svc.snapshotImageRefOverride,
    parentSandboxId ? { parentSandboxId } : undefined,
  );
  onCreated(sandbox);
  throwIfAborted(signal);
  const inspected = await getSandbox(sandbox.id);
  onInspected(inspected);
  return inspected;
}

/** Launch a service's start command detached, the same way waitForAppReady launches the app: its own
 *  session so it outlives this exec, stdin detached so it is not signalled when the exec returns. */
async function launchMeshService(sandbox: Sandbox, startCommand: string): Promise<void> {
  const escaped = startCommand.replace(/'/g, "'\\''");
  await execute(sandbox, `setsid sh -c '${escaped}' </dev/null >/tmp/bountydesk-app.log 2>&1 & echo launched`, 10);
}

/** Poll from inside until a dependency is listening on its port, so the app does not connect before
 *  the datastore is up. A datastore does not speak HTTP, so this checks the listening socket rather
 *  than an HTTP status. */
async function waitForPortListening(sandbox: Sandbox, port: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  // curl (present on every mesh node, see the build driver) tests the TCP connect: exit 7 is
  // connection refused and 28 is a connect timeout, both "not up"; any other exit means the port
  // accepted the connection (a datastore answers with a non-HTTP reply, which is still a connect).
  // ss and netstat are absent from minimal datastore images, so this does not rely on them.
  const probe =
    `curl -s -o /dev/null --connect-timeout 3 http://127.0.0.1:${port}/ >/dev/null 2>&1; ` +
    `c=$?; if [ "$c" != "7" ] && [ "$c" != "28" ]; then echo UP; else echo DOWN; fi`;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const result = await execute(sandbox, probe, 10);
    if (result.result.includes("UP")) return;
    await delay(READINESS_POLL_MS, signal);
  }
  throw new Error(`mesh dependency on sandbox ${sandbox.id} did not listen on port ${port} in time`);
}
