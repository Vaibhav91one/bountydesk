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
import { EXPECTED_BUILD_MARKER, TAG_PINNED_SNAPSHOT_IMAGE_REF, isValidImageDigest } from "@/lib/targets/configure";
import { buildMarkerCheck } from "./build-marker";
import { createSandbox, deleteSandbox, execute, getSandbox, getSnapshot, type Sandbox } from "./daytona";

const DAYTONA_API = "https://app.daytona.io/api";

/** Juice Shop's own start command (its package.json's `start` script). Backgrounded and
 * redirected so execute()'s own command timeout doesn't wait on a process that is meant to
 * keep running after this call returns. */
const START_APP_COMMAND = "cd /juice-shop && (nohup node build/app >/tmp/bountydesk-app.log 2>&1 &)";

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
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const started = await execute(sandbox, START_APP_COMMAND, 10);
  if (started.exitCode !== 0) {
    throw new Error(`sandbox ${sandbox.id} app start failed: ${started.result.slice(0, 200)}`);
  }

  const deadline = Date.now() + timeoutMs;
  const probe = `curl -s -o /dev/null -w '%{http_code}' http://localhost:${port}/ 2>/dev/null || echo 000`;

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const result = await execute(sandbox, probe, 10);
    const status = result.result.trim();
    if (/^2\d\d$/.test(status)) return;
    await delay(READINESS_POLL_MS, signal);
  }

  throw new Error(`sandbox ${sandbox.id} did not answer on port ${port} within ${timeoutMs}ms`);
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

  const haveCurl = await execute(sandbox, "command -v curl >/dev/null && echo CURL_PRESENT", 15);
  throwIfAborted(signal);
  if (!haveCurl.result.includes("CURL_PRESENT")) {
    throw new Error("curl is not available in the sandbox, so the egress probes prove nothing");
  }

  // IP literals only, deliberately: networkBlockAll blocks DNS resolution too, not just the
  // HTTP(S) request itself, so a by-hostname probe never reaches the interception proxy at
  // all. An IP literal skips DNS entirely and reaches the proxy directly, which is what
  // actually answers with the "Internet is restricted" 403 this loop checks for.
  const probes = [
    "http://1.1.1.1",
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  ];
  const denial = "Internet is restricted";

  for (const url of probes) {
    throwIfAborted(signal);
    const script = [
      ": > /tmp/bountydesk-egress.body",
      `curl -sS --max-time 8 -o /tmp/bountydesk-egress.body -w '%{http_code}' '${url}' > /tmp/bountydesk-egress.status 2>/tmp/bountydesk-egress.err`,
      "echo \"PROBE curl_exit=$? status=$(cat /tmp/bountydesk-egress.status)\"",
      "echo \"BODY $(head -c 120 /tmp/bountydesk-egress.body | tr -d '\\n')\"",
    ].join("; ");
    const result = await execute(sandbox, script, 20);
    throwIfAborted(signal);
    const parsed = /PROBE curl_exit=(\d+) status=(\d*)/.exec(result.result);
    if (result.exitCode !== 0 || !parsed) {
      throw new Error(`egress probe did not run (exit ${result.exitCode}): ${result.result.slice(0, 200)}`);
    }

    const status = parsed[2] === "" || parsed[2] === "000" ? null : parsed[2];
    const body = /BODY (.*)/.exec(result.result)?.[1]?.trim() ?? "";
    if (status === "403" && body.includes(denial)) continue;

    throw new Error(`reproduction sandbox reached ${url} despite networkBlockAll`);
  }
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
      TAG_PINNED_SNAPSHOT_IMAGE_REF,
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
    const markerMatches = await buildMarkerCheck(sandbox, EXPECTED_BUILD_MARKER);
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
    await waitForAppReady(sandbox, appPort, READINESS_TIMEOUT_MS, opts?.signal);
  } catch (error) {
    await teardownSandbox(sandbox.id, opts?.signal?.aborted === true);
    rethrowIfAborted(error, opts?.signal);
    throw new ProvisionTargetUnavailableError(errorMessage(error));
  }

  return { sandboxId: sandbox.id, appPort };
}
