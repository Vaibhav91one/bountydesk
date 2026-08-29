/**
 * The tri-state decision rule, isolated as one pure function so B-orchestrator and B-driver
 * agree on it exactly rather than each re-deriving it. NOT_REPRODUCED is only valid when the
 * negative control completed and stayed clean and the exploit oracle check completed -- both
 * legs actually ran to completion. A negative control that itself found the canary (dirty
 * fixture, cross-run contamination, a bug in the recipe) means neither leg can be trusted, so
 * that also falls through to ANALYSIS_ONLY rather than a guessed answer.
 */
export type ReproductionRun = {
  negativeControlCompleted: boolean;
  negativeControlCanaryFound: boolean;
  exploitCompleted: boolean;
  exploitCanaryFound: boolean;
};

export type ReproductionDecision = "REPRODUCED" | "NOT_REPRODUCED" | "ANALYSIS_ONLY";

export function decideOutcome(run: ReproductionRun): ReproductionDecision {
  if (!run.negativeControlCompleted || !run.exploitCompleted) return "ANALYSIS_ONLY";
  if (run.negativeControlCanaryFound) return "ANALYSIS_ONLY";
  return run.exploitCanaryFound ? "REPRODUCED" : "NOT_REPRODUCED";
}
