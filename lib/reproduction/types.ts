/**
 * Shared contracts for the reproduction pipeline (Track B). Every scenario is a frozen,
 * server-authored recipe: nothing here is agent- or report-supplied, so the capability-boundary
 * invariant in AGENTS.md ("scope is bound at the capability boundary, never from a string the
 * agent produced") holds by construction.
 *
 * The oracle boundary is the load-bearing rule this file encodes: a recipe's fixture,
 * negative-control and exploit requests are direct HTTP calls the controller makes and reads
 * itself. Nothing here is ever satisfied by text a sandbox's exec API returned: see AGENTS.md's
 * "a sandbox status file reports target readiness only... never determine reproduction", which
 * this design extends to sandbox-exec stdout in general.
 */

/** A JSON-compatible request body shape. This excludes functions, bigint, symbols and cycles
 * at the type boundary. Recipe authors still need ordinary finite numbers because TypeScript's
 * `number` also includes NaN and infinities. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ReproductionRequest =
  | {
      method: "GET";
      path: string;
      headers?: Record<string, string>;
      body?: never;
    }
  | {
      method: "POST";
      path: string;
      headers?: Record<string, string>;
      /** May contain the literal string "{{canary}}", substituted by the orchestrator with a
       * freshly generated value before the request is sent. */
      body?: JsonValue;
    };

export type ReproductionProbeResult = {
  status: number;
  body: string;
};

export type RequestBodyEvidence =
  | { dispatched: false; sha256: null }
  | { dispatched: true; sha256: string | null };

/**
 * One frozen reproduction scenario against a bound TargetProfile. Recipes are code, not data:
 * `oracleCheck` cannot live in a jsonb column, so recipes are looked up by target name in
 * lib/targets/recipes.ts rather than stored on target_profile.config. The existing
 * config.{baseUrl,searchPath,canaryRegistrationPath} fields stay exactly as they are today and
 * feed into building these requests; no schema or data migration is needed for this file.
 */
export type ReproductionRecipe = {
  /** Stable id, e.g. "juice-shop-sqli-search". Recorded in verdict.evidence. */
  id: string;
  /** Human label for evidence/summary text shown to the reviewer. */
  title: string;
  /** Case-insensitive substrings checked against a report's title and body before this recipe
   * is ever run. The driver requires at least one vulnerability-class keyword and at least one
   * scenario or endpoint keyword, so recipe authors should include both kinds. A class-only
   * match, such as "sql injection", is not enough to run an endpoint-specific recipe. */
  keywords: string[];
  /**
   * Whether this recipe's oracle can actually deliver a trustworthy verdict against the running
   * orchestrator. Omitted means ready, which is why juice-shop's frozen recipes carry nothing
   * here. Set to false for a recipe whose oracle would silently misjudge the target today, e.g.
   * one that sends JSON to a form-encoded endpoint, puts the canary in a GET path the
   * orchestrator never substitutes, or judges an out-of-band vulnerability from the in-band
   * response. authorizeReproductionTarget treats a not-ready recipe as NO_APPROVED_ORACLE, so
   * the run resolves ANALYSIS_ONLY and a false REPRODUCED is structurally impossible until the
   * gap named in docs/additional-targets.md is closed and this is flipped back to ready.
   */
  oracleReady?: boolean;
  /** Registers the canary through a trusted fixture call. `request.body` should reference
   * "{{canary}}" wherever the fresh value belongs. A non-2xx response here means the canary was
   * never actually seeded, so the orchestrator must treat that as incomplete, not proceed to the
   * oracle legs, and never emit a definitive verdict for this run. */
  fixture: { request: ReproductionRequest };
  /** Must NOT trip the oracle. Run before the exploit, and must complete and stay clean before
   * the exploit leg is attempted at all: see decideOutcome below. */
  negativeControl: ReproductionRequest;
  /** Extra HTTP status codes, beyond any 2xx, that count as completing legitimately rather than
   * as an infrastructure failure. Needed when the correct outcome is itself a non-2xx response --
   * e.g. a login recipe's negative control is a deliberately wrong password, which the target
   * correctly rejects with 401. Applied to the negative control always, and to the exploit's own
   * dispatch too when `exploitFollowUp` is present: a recipe whose exploit and negative control
   * hit the same endpoint (the login-bypass recipe posts to the same login route for both) can
   * see the same legitimate rejection on either leg. Absent for a recipe whose negative control
   * legitimately succeeds with 2xx (the search-SQLi recipe), which leaves that recipe's
   * behaviour in the orchestrator's runLeg exactly as it is today. */
  negativeControlAcceptedStatuses?: number[];
  exploit: ReproductionRequest;
  /**
   * Evaluates a response the controller received directly from the target -- never sandbox-exec
   * stdout -- for the presence of the given canary value. Always called for the negative control
   * (expected false). Called for the exploit too, unless `exploitFollowUp` is present, in which
   * case the follow-up's own oracleCheck decides the exploit leg instead (see below).
   */
  oracleCheck: (
    response: ReproductionProbeResult,
    canary: string,
  ) => Promise<boolean> | boolean;
  /**
   * A second oracle leg for a scenario where the exploit's own response can't prove anything by
   * itself -- it has to be used to make one more request first. The auth-bypass login recipe is
   * the motivating case: the exploit mints a token, and only a follow-up call with that token
   * (checked for this run's own canary) proves the token actually grants access, rather than
   * merely that some token came back. Absent for a recipe whose exploit response is the whole
   * proof (the search-SQLi recipe), which leaves that recipe running through the orchestrator's
   * single-response `oracleCheck` path exactly as it does today.
   */
  exploitFollowUp?: {
    /** Builds the next request from the exploit leg's own response -- e.g. extracting a minted
     * auth token. Returns undefined when the exploit response carries nothing to follow up on
     * (say, the injection didn't mint a token this run): the exploit leg then completes with no
     * proof, and the orchestrator never dispatches a follow-up request at all. */
    buildRequest: (exploitResponse: ReproductionProbeResult) => ReproductionRequest | undefined;
    /** Evaluates the follow-up response -- never the exploit's own response -- for the canary.
     * This is the leg that actually proves the exploit granted access, rather than merely
     * having returned something. */
    oracleCheck: (response: ReproductionProbeResult, canary: string) => Promise<boolean> | boolean;
  };
};

/**
 * What actually happened, recorded in verdict.evidence. Never the raw canary value or a raw
 * request body that embeds it -- verdict rows can never be edited or deleted (DB triggers), so
 * anything written here is permanent. Hash the canary and any body that carried it instead.
 */
export type ReproductionEvidence = {
  recipeId: string;
  sandboxId: string;
  /** The trusted fixture call that seeded the canary. `ranToCompletion` here specifically means
   * the target returned a 2xx: a fixture that errored never created a canary to look for, so a
   * false value here forces ANALYSIS_ONLY regardless of what the other two legs found. */
  fixture: { ranToCompletion: boolean; at: string };
  negativeControl: { ranToCompletion: boolean; canaryFound: boolean; at: string };
  exploit: { ranToCompletion: boolean; canaryFound: boolean; at: string };
  /** sha256 hex of the raw canary value. Never the value itself. */
  canaryHash: string;
  /** sha256 hex of each dispatched request body, or null when a dispatched request had no body.
   * `dispatched` is the distinction between a skipped request and a bodyless request. */
  requestBodyHashes: {
    fixture: RequestBodyEvidence;
    negativeControl: RequestBodyEvidence;
    exploit: RequestBodyEvidence;
  };
};

/**
 * The seven frozen ANALYSIS_ONLY reasons from docs/decisions.md / AGENTS.md. Any reproduction
 * failure that isn't a clean, fully-completed run records one of these -- never guesses
 * REPRODUCED or NOT_REPRODUCED on an incomplete run.
 */
export type AnalysisOnlyReason =
  | "NO_BOUND_TARGET"
  | "COULD_NOT_BUILD"
  | "COULD_NOT_DEPLOY"
  | "NO_APPROVED_ORACLE"
  | "TARGET_UNAVAILABLE"
  | "POLICY_REFUSED"
  | "INTAKE_PARSE_FAILED";

export type ReproductionOutcome =
  | { outcome: "REPRODUCED"; evidence: ReproductionEvidence }
  | { outcome: "NOT_REPRODUCED"; evidence: ReproductionEvidence }
  | {
      outcome: "ANALYSIS_ONLY";
      reason: AnalysisOnlyReason;
      evidence?: Partial<ReproductionEvidence>;
    };

/**
 * The two function signatures the parallel pieces of Track B are fixed against, so
 * lib/sandbox/reproduce.ts, lib/targets/recipes.ts and lib/analysis/trueforge-driver.ts's
 * integration can all be built concurrently without drifting on shape. Whoever lands last wires
 * the real implementations together; until then each side can mock against these types.
 *
 * Every field of `input` must be resolved by trusted server code from a bound `TargetProfile`
 * row (imageName, imageDigest, snapshotId) and a server-selected recipe, exactly as
 * `activeRepository()` resolves a GitHub repository's target today: never a value an agent
 * chose, and never a value that arrived on the report itself. `targetProfileId` is carried
 * through so the caller can bind evidence and audit records back to the exact profile that
 * authorized this run.
 */
export type ReproduceFn = (
  input: {
    targetProfileId: string;
    imageName: string;
    imageDigest: string;
    snapshotId: string | null;
    recipe: ReproductionRecipe;
  },
  opts?: { signal?: AbortSignal },
) => Promise<ReproductionOutcome>;

/** Returns [] when the named target has no known recipes -- the caller's cue to fall back to
 * today's unconditional ANALYSIS_ONLY behavior exactly as it works now. */
export type GetRecipesForTargetFn = (target: {
  name: string;
  config: unknown;
}) => ReproductionRecipe[];
