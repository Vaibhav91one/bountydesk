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

/** A JSON value, so a recipe's request body is provably serializable at compile time instead of
 * by runtime convention: `unknown` would let a bigint, a function, or a cyclic object satisfy
 * the type and then fail (or silently change meaning) when the orchestrator serializes it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ReproductionRequest = {
  method: "GET" | "POST";
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
  /** Registers the canary through a trusted fixture call. `request.body` should reference
   * "{{canary}}" wherever the fresh value belongs. A non-2xx response here means the canary was
   * never actually seeded, so the orchestrator must treat that as incomplete, not proceed to the
   * oracle legs, and never emit a definitive verdict for this run. */
  fixture: { request: ReproductionRequest };
  /** Must NOT trip the oracle. Run before the exploit, and must complete and stay clean before
   * the exploit leg is attempted at all: see decideOutcome below. */
  negativeControl: ReproductionRequest;
  exploit: ReproductionRequest;
  /**
   * Evaluates a response the controller received directly from the target -- never sandbox-exec
   * stdout -- for the presence of the given canary value. Called once for the negative control
   * (expected false) and once for the exploit (the real check).
   */
  oracleCheck: (
    response: ReproductionProbeResult,
    canary: string,
  ) => Promise<boolean> | boolean;
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
  /** sha256 hex of each request body that referenced the canary, or null if that request was
   * never actually sent. Populated as soon as the request is dispatched, independent of whether
   * the oracle check that follows succeeds, throws, or is never reached. */
  requestBodyHashes: {
    fixture: string | null;
    negativeControl: string | null;
    exploit: string | null;
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
 * row (imageDigest, snapshotId) and a server-selected recipe, exactly as `activeRepository()`
 * resolves a GitHub repository's target today: never a value an agent chose, and never a value
 * that arrived on the report itself. `targetProfileId` is carried through so the caller can bind
 * evidence and audit records back to the exact profile that authorized this run.
 */
export type ReproduceFn = (
  input: {
    targetProfileId: string;
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
