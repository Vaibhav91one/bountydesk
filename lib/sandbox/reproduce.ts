/**
 * The reproduction orchestrator: turns a frozen ReproductionRecipe into a real REPRODUCED /
 * NOT_REPRODUCED / ANALYSIS_ONLY verdict against a live Daytona sandbox.
 *
 * Provisioning the sandbox itself -- pick the image ref, boot from the pinned snapshot, verify
 * egress is blocked, verify build identity, wait for the app to answer its own port -- lives in
 * provisionTarget (./provision.ts), shared with lib/analysis/trueforge-driver.ts's turn-time
 * provisioning. What stays here is the oracle: the fixture, negative-control and exploit
 * requests are direct HTTP calls this process makes and reads itself, over the sandbox's
 * per-port preview URL, never text daytona.ts's execute() captured from inside the sandbox.
 * execute() only ever gates boot readiness, build-identity and the egress self-check inside
 * provisionTarget, never a verdict input, per the oracle boundary in lib/reproduction/types.ts.
 *
 * getPortPreviewUrl (also in ./provision.ts) is called fresh here, right after provisionTarget
 * returns, to get the token this file's oracle legs need: `public: false` never changes on the
 * sandbox, and this URL is reachable only with the token it comes back with -- confirmed live
 * against the pinned Juice Shop snapshot (see PR #33's description for the request/response
 * evidence): a no-token request gets 401 from Daytona's edge, and a token-bearing request that
 * reaches an unready app gets a 502 from the sandbox's own daemon, never today's sandbox
 * contents.
 */
import { createHash, randomBytes } from "node:crypto";

import { decideOutcome } from "@/lib/reproduction/decide";
import type {
  AnalysisOnlyReason,
  ReproduceFn,
  ReproductionEvidence,
  ReproductionOutcome,
  ReproductionProbeResult,
  ReproductionRecipe,
  ReproductionRequest,
  RequestBodyEvidence,
} from "@/lib/reproduction/types";
import {
  getPortPreviewUrl,
  positiveIntegerEnv,
  provisionTarget,
  ProvisionTargetUnavailableError,
  readLimitedText,
  rethrowIfAborted,
  teardownSandbox,
  throwIfAborted,
  timeoutSignal,
  type PortPreviewUrl,
} from "./provision";
import { authorizeReproductionTarget } from "../targets/authorize-reproduction";

export { positiveIntegerEnv };

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

// getPortPreviewUrl, timeoutSignal, abortReason, throwIfAborted, rethrowIfAborted,
// waitForAppReady, verifyNoEgress and readLimitedText all moved to ./provision.ts as part of
// extracting provisionTarget() (see that file's own doc comment). verifyNoEgress in
// particular -- the IP-literal probes that confirm networkBlockAll actually denies egress with
// the "Internet is restricted" 403, before anything else touches the sandbox -- now runs
// unchanged inside provisionTarget, which createReproducer calls below. Nothing about that
// check's behavior changed, only which file it lives in; it still runs before the
// fixture/negative-control/exploit legs on every call, exactly as it did here before.

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

/** The default notion of "this leg's response is trustworthy enough to hand to oracleCheck".
 * A redirect or an error status is treated as an infrastructure failure rather than data, which
 * is what keeps a proxy hiccup or a confused-deputy redirect from ever reaching the oracle: see
 * the "does not follow the target outside the preview origin" tests in reproduce.test.ts. */
function defaultIsAcceptableStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Run one negative-control or exploit leg: send it, hand the real response to the recipe's
 * own oracleCheck, and record what happened.
 *
 * `bodyEvidence` is tracked separately from "did this leg run to completion": the request can
 * be genuinely dispatched (sendToSandbox returns) and its body hash computed, and only then
 * have oracleCheck itself throw. That is a leg that didn't run to completion, but the request
 * really was sent, so the dispatch marker is kept.
 *
 * `isAcceptableStatus` defaults to 2xx-only, unchanged from before this parameter existed. A
 * recipe whose negative control legitimately completes on a non-2xx status (a rejected login
 * answering 401) passes a widened predicate instead; every other caller keeps the default and
 * behaves exactly as before.
 */
async function runLeg(
  preview: PortPreviewUrl,
  request: ReproductionRequest,
  canary: string,
  oracleCheck: (response: ReproductionProbeResult, canary: string) => Promise<boolean> | boolean,
  signal?: AbortSignal,
  isAcceptableStatus: (status: number) => boolean = defaultIsAcceptableStatus,
): Promise<LegResult> {
  const at = new Date().toISOString();
  let bodyEvidence: RequestBodyEvidence = { dispatched: false, sha256: null };
  try {
    const sent = await sendToSandbox(preview, request, canary, signal);
    bodyEvidence = sent.bodyEvidence;
    if (!isAcceptableStatus(sent.probe.status)) {
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
 * Runs an exploit leg whose oracle needs a second request: send the exploit, hand its response
 * to `followUp.buildRequest` (e.g. to pull out a minted auth token), send whatever that builds,
 * and let the follow-up's own oracleCheck -- never the exploit's response -- decide canaryFound.
 *
 * A `buildRequest` that declines to build anything (nothing to chase -- say, the injection
 * didn't mint a token this run) is a *complete* exploit leg with no proof: NOT_REPRODUCED, not
 * an infrastructure failure. A follow-up that fails to get a usable response is incomplete, the
 * same fail-closed treatment runLeg already gives any other broken leg.
 *
 * `isAcceptableStatus` gates only the exploit's own dispatch, matching runLeg's widened
 * negative-control check: when the exploit hits the same endpoint as the negative control (the
 * login-bypass recipe posts to the same login route for both), a legitimately-rejected attempt
 * answers with the same non-2xx status the negative control can. Treating that as "leg didn't
 * run" would misreport a correctly-blocked exploit as an infrastructure failure (ANALYSIS_ONLY)
 * instead of a real, complete answer with no proof (NOT_REPRODUCED). The follow-up request's own
 * status stays 2xx-only: nothing declares a legitimate non-2xx there.
 */
async function runExploitWithFollowUp(
  preview: PortPreviewUrl,
  exploitRequest: ReproductionRequest,
  followUp: NonNullable<ReproductionRecipe["exploitFollowUp"]>,
  canary: string,
  signal?: AbortSignal,
  isAcceptableStatus: (status: number) => boolean = defaultIsAcceptableStatus,
): Promise<LegResult> {
  const at = new Date().toISOString();
  let bodyEvidence: RequestBodyEvidence = { dispatched: false, sha256: null };
  try {
    const sentExploit = await sendToSandbox(preview, exploitRequest, canary, signal);
    bodyEvidence = sentExploit.bodyEvidence;
    if (!isAcceptableStatus(sentExploit.probe.status)) {
      return { ranToCompletion: false, canaryFound: false, at, bodyEvidence };
    }

    const followUpRequest = followUp.buildRequest(sentExploit.probe);
    if (!followUpRequest) {
      return { ranToCompletion: true, canaryFound: false, at, bodyEvidence };
    }

    const sentFollowUp = await sendToSandbox(preview, followUpRequest, canary, signal);
    if (!defaultIsAcceptableStatus(sentFollowUp.probe.status)) {
      return { ranToCompletion: false, canaryFound: false, at, bodyEvidence };
    }
    const canaryFound = await followUp.oracleCheck(sentFollowUp.probe, canary);
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
  let sandboxId: string | undefined;
  let cancellationInFlight = false;

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

    // Steps 1-8 (image ref, boot from the pinned snapshot, verify egress is blocked, verify
    // build identity, wait for the app to answer its own port) live in provisionTarget now --
    // see lib/sandbox/provision.ts. This is the same sequence that used to run inline here,
    // just shared with the driver's turn-time provisioning.
    let provisioned: { sandboxId: string; appPort: number };
    try {
      provisioned = await provisionTarget(
        {
          imageName: authorization.imageName,
          imageDigest: authorization.imageDigest,
          snapshotId: authorization.snapshotId,
          targetProfileId: input.targetProfileId,
          recipeId,
        },
        authorization.appPort,
        { signal: opts?.signal },
      );
    } catch (error) {
      rethrowIfAborted(error, opts?.signal);
      const reason = error instanceof ProvisionTargetUnavailableError ? "TARGET_UNAVAILABLE" : "COULD_NOT_DEPLOY";
      return analysisOnly(reason, { recipeId });
    }
    sandboxId = provisioned.sandboxId;

    const canary = generateCanary();
    const canaryHash = sha256Hex(canary);

    let preview: PortPreviewUrl;
    try {
      preview = await getPortPreviewUrl(sandboxId, provisioned.appPort, opts?.signal);
    } catch (error) {
      rethrowIfAborted(error, opts?.signal);
      return analysisOnly("TARGET_UNAVAILABLE", { recipeId, sandboxId, canaryHash });
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
      const negativeControlIsAcceptable = recipe.negativeControlAcceptedStatuses
        ? (status: number) =>
            defaultIsAcceptableStatus(status) || recipe.negativeControlAcceptedStatuses!.includes(status)
        : undefined;

      negativeControl = await runLeg(
        preview,
        recipe.negativeControl,
        canary,
        recipe.oracleCheck,
        opts?.signal,
        negativeControlIsAcceptable,
      );

      if (negativeControl.ranToCompletion && !negativeControl.canaryFound) {
        exploit = recipe.exploitFollowUp
          ? await runExploitWithFollowUp(
              preview,
              recipe.exploit,
              recipe.exploitFollowUp,
              canary,
              opts?.signal,
              negativeControlIsAcceptable,
            )
          : await runLeg(preview, recipe.exploit, canary, recipe.oracleCheck, opts?.signal);
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
      sandboxId,
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
    cancellationInFlight = opts?.signal?.aborted === true;
    rethrowIfAborted(error, opts?.signal);
    // Anything unaccounted for above is infrastructure until proven otherwise, never a
    // guessed verdict.
    return analysisOnly("TARGET_UNAVAILABLE", { recipeId });
  } finally {
    if (sandboxId) {
      await teardownSandbox(sandboxId, cancellationInFlight);
    }
  }
  };
}

export const reproduce: ReproduceFn = createReproducer();
