/**
 * The reproduction orchestrator: turns a frozen ReproductionRecipe into a real REPRODUCED /
 * NOT_REPRODUCED / ANALYSIS_ONLY verdict against a live Daytona sandbox.
 *
 * The oracle boundary from lib/reproduction/types.ts is the rule this file exists to hold:
 * the fixture, negative-control and exploit requests are direct HTTP calls this process makes
 * and reads itself, over the sandbox's per-port preview URL, never text daytona.ts's execute()
 * captured from inside the sandbox. execute() is used only for boot and build-identity checks,
 * never a verdict input: waitForAppReady launches the app and polls for it answering its own
 * port, per AGENTS.md's "READY means the target started and answered its health check", and
 * buildMarkerCheck (build-marker.ts) confirms which image actually booted. The pinned snapshot
 * boots Daytona's own agent as PID 1 and does not run the image's own start command on its
 * own, confirmed live: nothing answers :3000 until this runs it explicitly.
 *
 * daytona.ts deliberately doesn't expose the per-port preview endpoint (it isn't one of the
 * five calls the reproduction-sandbox lifecycle needs), so this file calls it directly. It is
 * the mechanism a `public: false` sandbox uses to hand out one reachable, token-gated URL for
 * a single port without making the sandbox itself public: confirmed live against the pinned
 * Juice Shop snapshot (see the PR description for the request/response evidence) -- a
 * no-token request gets 401 from Daytona's edge, and a token-bearing request that reaches an
 * unready app gets a 502 from the sandbox's own daemon, never today's sandbox contents.
 */
import { createHash, randomBytes } from "node:crypto";

import { requireSecret } from "@/lib/env";
import { decideOutcome } from "@/lib/reproduction/decide";
import type {
  AnalysisOnlyReason,
  ReproduceFn,
  ReproductionEvidence,
  ReproductionOutcome,
  ReproductionProbeResult,
  ReproductionRequest,
  RequestBodyEvidence,
} from "@/lib/reproduction/types";
import { EXPECTED_BUILD_MARKER, TAG_PINNED_SNAPSHOT_IMAGE_REF, isValidImageDigest } from "@/lib/targets/configure";
import { buildMarkerCheck } from "./build-marker";
import { createSandbox, deleteSandbox, execute, getSandbox, getSnapshot, type Sandbox } from "./daytona";
import { authorizeReproductionTarget } from "../targets/authorize-reproduction";

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

/** Wall-clock ceiling on each direct HTTP call this process makes to the sandbox or to
 * Daytona's control plane. */
const HTTP_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BODY_BYTES = 1_000_000;

/** Our ceiling on how long a reproduction sandbox lives, same order of magnitude as the spike
 * script's. Short: a run either finishes in a couple of minutes or something is wrong. */
const SANDBOX_TTL_MINUTES = 10;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

class ResponseBodyTooLarge extends Error {
  constructor(limit: number) {
    super(`sandbox response exceeded ${limit} bytes`);
    this.name = "ResponseBodyTooLarge";
  }
}

function imageRefForProfile(imageName: string, imageDigest: string): string {
  if (!isValidImageDigest(imageDigest)) {
    throw new Error(`not a valid image digest: ${imageDigest}`);
  }
  return `${imageName}@${imageDigest}`;
}

/** Fresh and unpredictable every run, per decisions.md Q3 -- never a fixed literal. 18 random
 * bytes, base64url-encoded, is short enough to fit comfortably in a search response or a JWT
 * dump and long enough that a PoC cannot guess or precompute it. */
function generateCanary(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Replace every occurrence of the literal placeholder with the run's canary, anywhere it
 * appears in a JSON-serializable value. A recipe's body may be a plain string, or an object
 * with the placeholder nested in one field (e.g. `{ email: "{{canary}}", password: "..." }`),
 * so this walks the whole structure rather than assuming a fixed shape.
 */
function substituteCanary(value: unknown, canary: string): unknown {
  if (typeof value === "string") return value.split("{{canary}}").join(canary);
  if (Array.isArray(value)) return value.map((item) => substituteCanary(item, canary));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        substituteCanary(item, canary),
      ]),
    );
  }
  return value;
}

type PortPreviewUrl = { url: string; token: string };

/**
 * Ask Daytona's control plane for a token-gated URL onto one port of a non-public sandbox.
 * This is the mechanism the design-rule comment above rests on: `public: false` never
 * changes, and this URL is reachable only with the token it comes back with.
 */
async function getPortPreviewUrl(
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

function timeoutSignal(outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("operation aborted");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
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

/**
 * Poll the sandbox from inside until its app port answers, or give up.
 *
 * This is the one place execute() is allowed to gate anything: a boot check, matching
 * AGENTS.md's "READY means the target started and answered its health check". The status
 * code is read only to decide whether to keep polling, never fed into the oracle.
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

  const probes = [
    "https://example.com",
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

async function readLimitedText(response: Response, limitBytes = MAX_RESPONSE_BODY_BYTES): Promise<string> {
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

type SentRequest = { probe: ReproductionProbeResult; bodyEvidence: RequestBodyEvidence };

/** Send one recipe leg as a real HTTP request to the sandbox's preview URL, and read the real
 * Response -- the direct-call half of the oracle-boundary rule. */
async function sendToSandbox(
  preview: PortPreviewUrl,
  request: ReproductionRequest,
  canary: string,
  signal?: AbortSignal,
): Promise<SentRequest> {
  const body = request.body === undefined ? undefined : substituteCanary(request.body, canary);
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  const url = `${preview.url.replace(/\/$/, "")}${request.path}`;

  const response = await fetch(url, {
    method: request.method,
    headers: sandboxRequestHeaders(request.headers, preview.token, bodyText !== undefined),
    body: bodyText,
    redirect: "manual",
    signal: timeoutSignal(signal),
  });

  const text = await readLimitedText(response);
  return {
    probe: { status: response.status, body: text },
    bodyEvidence: {
      dispatched: true,
      sha256: bodyText === undefined ? null : sha256Hex(bodyText),
    },
  };
}

function sandboxRequestHeaders(
  recipeHeaders: Record<string, string> | undefined,
  previewToken: string,
  hasBody: boolean,
): Headers {
  const headers = new Headers(recipeHeaders);
  if (hasBody) headers.set("content-type", "application/json");
  headers.set("x-daytona-preview-token", previewToken);
  return headers;
}

type LegResult = {
  ranToCompletion: boolean;
  canaryFound: boolean;
  at: string;
  bodyEvidence: RequestBodyEvidence;
};

function notRun(at: string): LegResult {
  return { ranToCompletion: false, canaryFound: false, at, bodyEvidence: { dispatched: false, sha256: null } };
}

/**
 * Run one negative-control or exploit leg: send it, hand the real response to the recipe's
 * own oracleCheck, and record what happened.
 *
 * `bodyEvidence` is tracked separately from "did this leg run to completion": the request can
 * be genuinely dispatched (sendToSandbox returns) and its body hash computed, and only then
 * have oracleCheck itself throw. That is a leg that didn't run to completion, but the request
 * really was sent, so the dispatch marker is kept.
 */
async function runLeg(
  preview: PortPreviewUrl,
  request: ReproductionRequest,
  canary: string,
  oracleCheck: (response: ReproductionProbeResult, canary: string) => Promise<boolean> | boolean,
  signal?: AbortSignal,
): Promise<LegResult> {
  const at = new Date().toISOString();
  let bodyEvidence: RequestBodyEvidence = { dispatched: false, sha256: null };
  try {
    const sent = await sendToSandbox(preview, request, canary, signal);
    bodyEvidence = sent.bodyEvidence;
    if (sent.probe.status < 200 || sent.probe.status >= 300) {
      return { ranToCompletion: false, canaryFound: false, at, bodyEvidence };
    }
    const canaryFound = await oracleCheck(sent.probe, canary);
    return { ranToCompletion: true, canaryFound, at, bodyEvidence };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return { ranToCompletion: false, canaryFound: false, at, bodyEvidence };
  }
}

/**
 * Any failure this function catches maps onto one of the seven frozen ANALYSIS_ONLY reasons.
 * A run this far along always has a bound target and an approved recipe (reproduce.ts is only
 * ever called with one), which rules out NO_BOUND_TARGET, POLICY_REFUSED and
 * INTAKE_PARSE_FAILED -- those belong to earlier pipeline stages -- and COULD_NOT_BUILD, which
 * belongs to the dynamic build tier this pinned-image path never runs. What is left is a
 * three-way split: the sandbox itself never came up, or came up on the wrong build
 * (COULD_NOT_DEPLOY -- see build-marker.ts for the second case); it came up but never
 * answered, a request to it failed in flight, or the trusted fixture never seeded a canary to
 * look for at all (TARGET_UNAVAILABLE); or the negative control and exploit both ran but
 * produced a run decideOutcome refuses to trust -- an incomplete leg or a negative control
 * that itself found the canary -- which is a statement about the oracle result for this run,
 * not about reachability (NO_APPROVED_ORACLE).
 */
function analysisOnly(reason: AnalysisOnlyReason, evidence?: Partial<ReproductionEvidence>): ReproductionOutcome {
  return { outcome: "ANALYSIS_ONLY", reason, evidence };
}

type AuthorizeReproductionTargetFn = typeof authorizeReproductionTarget;

export function createReproducer(authorizeTarget: AuthorizeReproductionTargetFn = authorizeReproductionTarget): ReproduceFn {
  return async (input, opts) => {
  const recipeId = input.recipe.id;
  let sandbox: Sandbox | undefined;

  try {
    throwIfAborted(opts?.signal);
    const authorization = await authorizeTarget({
      targetProfileId: input.targetProfileId,
      recipeId,
    });
    throwIfAborted(opts?.signal);
    if (!authorization.ok) {
      return analysisOnly(authorization.reason, { recipeId });
    }

    const recipe = authorization.recipe;

    if (!authorization.snapshotId) {
      return analysisOnly("TARGET_UNAVAILABLE", { recipeId });
    }

    let imageRef: string;
    try {
      imageRef = imageRefForProfile(authorization.imageName, authorization.imageDigest);
    } catch (error) {
      rethrowIfAborted(error, opts?.signal);
      return analysisOnly("COULD_NOT_DEPLOY", { recipeId });
    }

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
          labels: { "bountydesk.recipe": recipeId, "bountydesk.targetProfileId": input.targetProfileId },
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
      rethrowIfAborted(error, opts?.signal);
      return analysisOnly("COULD_NOT_DEPLOY", { recipeId });
    }

    throwIfAborted(opts?.signal);

    try {
      await verifyNoEgress(sandbox, opts?.signal);
    } catch (error) {
      rethrowIfAborted(error, opts?.signal);
      return analysisOnly("COULD_NOT_DEPLOY", { recipeId, sandboxId: sandbox.id });
    }

    // A second, independent proof of build identity (see build-marker.ts), on top of
    // assertSnapshotImage's control-plane check that createSandbox already ran above. This
    // reads a marker from the booted image before the target application starts, so a mismatched
    // tag-pinned snapshot cannot execute target code before being rejected.
    const markerMatches = await buildMarkerCheck(sandbox, EXPECTED_BUILD_MARKER);
    throwIfAborted(opts?.signal);
    if (!markerMatches) {
      return analysisOnly("COULD_NOT_DEPLOY", { recipeId, sandboxId: sandbox.id });
    }

    try {
      await waitForAppReady(sandbox, authorization.appPort, READINESS_TIMEOUT_MS, opts?.signal);
    } catch (error) {
      rethrowIfAborted(error, opts?.signal);
      return analysisOnly("TARGET_UNAVAILABLE", { recipeId, sandboxId: sandbox.id });
    }

    const canary = generateCanary();
    const canaryHash = sha256Hex(canary);

    let preview: PortPreviewUrl;
    try {
      preview = await getPortPreviewUrl(sandbox.id, authorization.appPort, opts?.signal);
    } catch (error) {
      rethrowIfAborted(error, opts?.signal);
      return analysisOnly("TARGET_UNAVAILABLE", { recipeId, sandboxId: sandbox.id, canaryHash });
    }

    // The fixture seeds the canary through the trusted registration endpoint, never through
    // anything the exploit request can reach directly (decisions.md Q3). A response that isn't
    // a genuine 2xx means the canary was never actually seeded, so there is nothing for the
    // negative control or the exploit to look for -- both are skipped entirely rather than run
    // against a sandbox with no canary in it.
    const fixtureAt = new Date().toISOString();
    let fixtureBodyEvidence: RequestBodyEvidence = { dispatched: false, sha256: null };
    let fixtureCompleted = false;
    try {
      const sent = await sendToSandbox(preview, recipe.fixture.request, canary, opts?.signal);
      fixtureBodyEvidence = sent.bodyEvidence;
      fixtureCompleted = sent.probe.status >= 200 && sent.probe.status < 300;
    } catch (error) {
      rethrowIfAborted(error, opts?.signal);
      fixtureCompleted = false;
    }

    throwIfAborted(opts?.signal);

    // Negative control next, always, per Q3 -- but only if the fixture actually seeded a
    // canary, and the exploit only if the negative control both completed and stayed clean.
    // Anything short-circuited here is recorded as never having run, not guessed at.
    let negativeControl = notRun(fixtureAt);
    let exploit = notRun(fixtureAt);

    if (fixtureCompleted) {
      negativeControl = await runLeg(
        preview,
        recipe.negativeControl,
        canary,
        recipe.oracleCheck,
        opts?.signal,
      );

      if (negativeControl.ranToCompletion && !negativeControl.canaryFound) {
        exploit = await runLeg(preview, recipe.exploit, canary, recipe.oracleCheck, opts?.signal);
      }
    }

    const decision = decideOutcome({
      fixtureCompleted,
      negativeControlCompleted: negativeControl.ranToCompletion,
      negativeControlCanaryFound: negativeControl.canaryFound,
      exploitCompleted: exploit.ranToCompletion,
      exploitCanaryFound: exploit.canaryFound,
    });

    const evidence: ReproductionEvidence = {
      recipeId,
      sandboxId: sandbox.id,
      fixture: { ranToCompletion: fixtureCompleted, at: fixtureAt },
      negativeControl: {
        ranToCompletion: negativeControl.ranToCompletion,
        canaryFound: negativeControl.canaryFound,
        at: negativeControl.at,
      },
      exploit: {
        ranToCompletion: exploit.ranToCompletion,
        canaryFound: exploit.canaryFound,
        at: exploit.at,
      },
      canaryHash,
      requestBodyHashes: {
        fixture: fixtureBodyEvidence,
        negativeControl: negativeControl.bodyEvidence,
        exploit: exploit.bodyEvidence,
      },
    };

    if (decision === "ANALYSIS_ONLY") {
      // A fixture that never completed means no canary was ever seeded, the same "request to
      // the target failed" class as TARGET_UNAVAILABLE's other cases. Once the fixture is
      // clean, an incomplete or dirty negative control (or an incomplete exploit) is a
      // statement about the oracle result, not about reachability: NO_APPROVED_ORACLE.
      const reason: AnalysisOnlyReason = fixtureCompleted ? "NO_APPROVED_ORACLE" : "TARGET_UNAVAILABLE";
      return analysisOnly(reason, evidence);
    }
    return { outcome: decision, evidence };
  } catch (error) {
    rethrowIfAborted(error, opts?.signal);
    // Anything unaccounted for above is infrastructure until proven otherwise, never a
    // guessed verdict.
    return analysisOnly("TARGET_UNAVAILABLE", { recipeId });
  } finally {
    if (sandbox) {
      const sandboxId = sandbox.id;
      await deleteSandbox(sandboxId).catch((error) => {
        if (opts?.signal?.aborted) {
          console.error(
            `failed to delete reproduction sandbox ${sandboxId} after cancellation: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
        throw new Error(
          `failed to delete reproduction sandbox ${sandboxId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      });
    }
  }
  };
}

export const reproduce: ReproduceFn = createReproducer();
