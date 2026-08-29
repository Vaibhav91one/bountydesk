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
} from "@/lib/reproduction/types";
import { imageRefFor } from "@/lib/targets/configure";
import { buildMarkerCheck } from "./build-marker";
import { createSandbox, deleteSandbox, execute, getSnapshot, type Sandbox } from "./daytona";

const DAYTONA_API = "https://app.daytona.io/api";

/**
 * Juice Shop's app port. The one frozen TargetProfile (decisions.md Q18) declares
 * `config.baseUrl` as "http://localhost:3000", but ReproduceFn's input carries only the
 * digest, snapshot and recipe, not the profile's config -- so this stays a constant until a
 * second target with a different port earns a real parameter here.
 */
const APP_PORT = 3000;

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
const READINESS_TIMEOUT_MS = Number(process.env.BOUNTYDESK_REPRODUCE_READINESS_TIMEOUT_MS) || 90_000;
const READINESS_POLL_MS = Number(process.env.BOUNTYDESK_REPRODUCE_READINESS_POLL_MS) || 3_000;

/** Wall-clock ceiling on each direct HTTP call this process makes to the sandbox or to
 * Daytona's control plane. */
const HTTP_TIMEOUT_MS = 15_000;

/** Our ceiling on how long a reproduction sandbox lives, same order of magnitude as the spike
 * script's. Short: a run either finishes in a couple of minutes or something is wrong. */
const SANDBOX_TTL_MINUTES = 10;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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

/**
 * Poll the sandbox from inside until its app port answers, or give up.
 *
 * This is the one place execute() is allowed to gate anything: a boot check, matching
 * AGENTS.md's "READY means the target started and answered its health check". The status
 * code is read only to decide whether to keep polling, never fed into the oracle.
 */
async function waitForAppReady(sandbox: Sandbox, timeoutMs: number): Promise<void> {
  await execute(sandbox, START_APP_COMMAND, 10);

  const deadline = Date.now() + timeoutMs;
  const probe = `curl -s -o /dev/null -w '%{http_code}' http://localhost:${APP_PORT}/ 2>/dev/null || echo 000`;

  while (Date.now() < deadline) {
    const result = await execute(sandbox, probe, 10);
    const status = result.result.trim();
    if (/^2\d\d$/.test(status)) return;
    await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_MS));
  }

  throw new Error(`sandbox ${sandbox.id} did not answer on port ${APP_PORT} within ${timeoutMs}ms`);
}

type SentRequest = { probe: ReproductionProbeResult; bodyHash: string | null };

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
    headers: {
      "x-daytona-preview-token": preview.token,
      ...(bodyText !== undefined ? { "content-type": "application/json" } : {}),
      ...request.headers,
    },
    body: bodyText,
    signal: timeoutSignal(signal),
  });

  const text = await response.text();
  return {
    probe: { status: response.status, body: text },
    bodyHash: bodyText === undefined ? null : sha256Hex(bodyText),
  };
}

type LegResult = { ranToCompletion: boolean; canaryFound: boolean; at: string; bodyHash: string | null };

/**
 * Run one negative-control or exploit leg: send it, hand the real response to the recipe's
 * own oracleCheck, and record what happened. A leg that throws anywhere along the way --
 * network failure, a malformed response, oracleCheck itself misbehaving -- is recorded as
 * not having run to completion rather than guessed at, which is what lets decideOutcome
 * refuse a verdict on a partial run instead of this function refusing on its behalf.
 */
async function runLeg(
  preview: PortPreviewUrl,
  request: ReproductionRequest,
  canary: string,
  oracleCheck: (response: ReproductionProbeResult, canary: string) => Promise<boolean> | boolean,
  signal?: AbortSignal,
): Promise<LegResult> {
  const at = new Date().toISOString();
  try {
    const sent = await sendToSandbox(preview, request, canary, signal);
    const canaryFound = await oracleCheck(sent.probe, canary);
    return { ranToCompletion: true, canaryFound, at, bodyHash: sent.bodyHash };
  } catch {
    return { ranToCompletion: false, canaryFound: false, at, bodyHash: null };
  }
}

/**
 * Any failure this function catches maps onto one of the seven frozen ANALYSIS_ONLY reasons.
 * A run this far along always has a bound target and an approved recipe (reproduce.ts is only
 * ever called with one), which rules out NO_BOUND_TARGET, POLICY_REFUSED and
 * INTAKE_PARSE_FAILED -- those belong to earlier pipeline stages -- and COULD_NOT_BUILD, which
 * belongs to the dynamic build tier this pinned-image path never runs. What is left is a
 * three-way split: the sandbox itself never came up, or came up on the wrong build
 * (COULD_NOT_DEPLOY -- see build-marker.ts for the second case), it came up but never
 * answered or a request to it failed in flight (TARGET_UNAVAILABLE), or both legs of the
 * oracle ran but produced a run decideOutcome refuses to trust -- an incomplete leg or a
 * negative control that itself found the canary -- which is a statement about the oracle
 * result for this run, not about reachability (NO_APPROVED_ORACLE).
 */
function analysisOnly(reason: AnalysisOnlyReason, evidence?: Partial<ReproductionEvidence>): ReproductionOutcome {
  return { outcome: "ANALYSIS_ONLY", reason, evidence };
}

export const reproduce: ReproduceFn = async (input, opts) => {
  const recipeId = input.recipe.id;
  let sandbox: Sandbox | undefined;

  try {
    if (!input.snapshotId) {
      return analysisOnly("TARGET_UNAVAILABLE", { recipeId });
    }

    let imageRef: string;
    try {
      imageRef = imageRefFor(input.imageDigest);
    } catch {
      return analysisOnly("COULD_NOT_DEPLOY", { recipeId });
    }

    try {
      const snapshotInfo = await getSnapshot(input.snapshotId);
      sandbox = await createSandbox({
        snapshot: input.snapshotId,
        imageRef,
        // Matched to the snapshot's own declared limits, the same way scripts/spike-daytona.ts
        // does it: createSandbox refuses to request resources of its own, so these are read
        // back from the snapshot record and createSandbox re-verifies them before it provisions.
        cpu: snapshotInfo.cpu ?? 0,
        memoryGb: snapshotInfo.mem ?? 0,
        diskGb: snapshotInfo.disk ?? 0,
        ttlMinutes: SANDBOX_TTL_MINUTES,
        labels: { "bountydesk.recipe": recipeId },
      });
    } catch {
      return analysisOnly("COULD_NOT_DEPLOY", { recipeId });
    }

    opts?.signal?.throwIfAborted();

    try {
      await waitForAppReady(sandbox, READINESS_TIMEOUT_MS);
    } catch {
      return analysisOnly("TARGET_UNAVAILABLE", { recipeId, sandboxId: sandbox.id });
    }

    // A second, independent proof of build identity (see build-marker.ts), on top of
    // assertSnapshotImage's control-plane check that createSandbox already ran above. A
    // mismatch here is the same class of failure as a snapshot that never came up correctly,
    // so it shares COULD_NOT_DEPLOY rather than adding a new reason to the frozen union.
    if (!(await buildMarkerCheck(sandbox, input.imageDigest))) {
      return analysisOnly("COULD_NOT_DEPLOY", { recipeId, sandboxId: sandbox.id });
    }

    const canary = generateCanary();
    const canaryHash = sha256Hex(canary);

    let preview: PortPreviewUrl;
    try {
      preview = await getPortPreviewUrl(sandbox.id, APP_PORT, opts?.signal);
    } catch {
      return analysisOnly("TARGET_UNAVAILABLE", { recipeId, sandboxId: sandbox.id, canaryHash });
    }

    // The fixture seeds the canary through the trusted registration endpoint, never through
    // anything the exploit request can reach directly (decisions.md Q3). A fixture that fails
    // to complete means there is no canary to look for, so nothing past this point can be
    // trusted either.
    try {
      await sendToSandbox(preview, input.recipe.fixture.request, canary, opts?.signal);
    } catch {
      return analysisOnly("TARGET_UNAVAILABLE", { recipeId, sandboxId: sandbox.id, canaryHash });
    }

    opts?.signal?.throwIfAborted();

    // Negative control first, always, per Q3 -- and the exploit still runs even if the
    // control didn't complete cleanly, so the evidence packet reflects what actually
    // happened. decideOutcome is what refuses to trust an unclean or partial run, not this
    // function skipping ahead of it.
    const negativeControl = await runLeg(
      preview,
      input.recipe.negativeControl,
      canary,
      input.recipe.oracleCheck,
      opts?.signal,
    );
    const exploit = await runLeg(preview, input.recipe.exploit, canary, input.recipe.oracleCheck, opts?.signal);

    const decision = decideOutcome({
      negativeControlCompleted: negativeControl.ranToCompletion,
      negativeControlCanaryFound: negativeControl.canaryFound,
      exploitCompleted: exploit.ranToCompletion,
      exploitCanaryFound: exploit.canaryFound,
    });

    const evidence: ReproductionEvidence = {
      recipeId,
      sandboxId: sandbox.id,
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
        negativeControl: negativeControl.bodyHash,
        exploit: exploit.bodyHash,
      },
    };

    if (decision === "ANALYSIS_ONLY") return analysisOnly("NO_APPROVED_ORACLE", evidence);
    return { outcome: decision, evidence };
  } catch {
    // Anything unaccounted for above -- an unexpected throw, an aborted signal bubbling up --
    // is infrastructure until proven otherwise, never a guessed verdict.
    return analysisOnly("TARGET_UNAVAILABLE", { recipeId });
  } finally {
    if (sandbox) {
      // Best-effort by design (deleteSandbox already retries on 409); the provider TTL and
      // the reconciler are what actually guarantee cleanup, not this call succeeding.
      await deleteSandbox(sandbox.id).catch(() => undefined);
    }
  }
};
