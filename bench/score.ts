/**
 * Score a benchmark run against its ground truth. Pure and offline: it takes expected and actual
 * verdicts per case, never reads the database, the harness, or the network.
 *
 * Expected is one of the three outcomes a human ever has to sign off on for a case in this corpus
 * (REPRODUCED, NOT_REPRODUCED, ANALYSIS_ONLY); actual is whatever the pipeline produced, which can
 * also be INCONCLUSIVE. INCONCLUSIVE and ANALYSIS_ONLY both mean "no definitive call", so for the
 * 3x3 matrix and the rate calculations an actual INCONCLUSIVE collapses into the ANALYSIS_ONLY
 * column (see docs/benchmark.md for why: an abstention is an abstention regardless of which of
 * the two labels the pipeline used for it).
 */

export type GroundTruthOutcome = "REPRODUCED" | "NOT_REPRODUCED" | "ANALYSIS_ONLY";
export type ActualOutcome = GroundTruthOutcome | "INCONCLUSIVE";

export type CaseResult = {
  id: string;
  expected: GroundTruthOutcome;
  actual: ActualOutcome;
};

const OUTCOMES: readonly GroundTruthOutcome[] = ["REPRODUCED", "NOT_REPRODUCED", "ANALYSIS_ONLY"];

/** Rows are expected, columns are actual (an actual INCONCLUSIVE counted under ANALYSIS_ONLY). */
export type ConfusionMatrix = Record<GroundTruthOutcome, Record<GroundTruthOutcome, number>>;

export type Scorecard = {
  total: number;
  matrix: ConfusionMatrix;
  /** REPRODUCED claimed on a case whose ground truth is anything but REPRODUCED (a real bug
   *  that was not actually there to find), as a fraction of all negative (non-REPRODUCED) cases. */
  falsePositiveRate: number;
  /** Fraction of negative (non-REPRODUCED) cases scored anything but REPRODUCED: the number that
   *  matters most here, per arXiv 2511.18608's finding that models over-accept invalid reports. */
  invalidRecall: number;
  /** NOT_REPRODUCED or ANALYSIS_ONLY claimed on a case whose ground truth is REPRODUCED (a real
   *  bug that was missed), as a fraction of all positive (REPRODUCED) cases. */
  falseNegativeRate: number;
  /** Fraction of all cases where the actual outcome was ANALYSIS_ONLY or INCONCLUSIVE while the
   *  ground truth called for a definitive REPRODUCED or NOT_REPRODUCED: declined to call it. */
  abstentionRate: number;
  /** Exact match rate, computed only over cases where the actual outcome was not an abstention
   *  (so a pipeline cannot inflate its score by abstaining on everything hard). */
  accuracyOnNonAbstained: number;
};

function emptyMatrix(): ConfusionMatrix {
  const matrix = {} as ConfusionMatrix;
  for (const expected of OUTCOMES) {
    matrix[expected] = { REPRODUCED: 0, NOT_REPRODUCED: 0, ANALYSIS_ONLY: 0 };
  }
  return matrix;
}

function collapse(actual: ActualOutcome): GroundTruthOutcome {
  return actual === "INCONCLUSIVE" ? "ANALYSIS_ONLY" : actual;
}

/** Score one run (one actual outcome per case) against the corpus's ground truth. */
export function score(results: readonly CaseResult[]): Scorecard {
  if (results.length === 0) throw new Error("score: no results to score");

  const matrix = emptyMatrix();
  let negatives = 0;
  let falsePositives = 0;
  let positives = 0;
  let falseNegatives = 0;
  let abstentions = 0;
  let nonAbstainedTotal = 0;
  let nonAbstainedCorrect = 0;

  for (const { expected, actual } of results) {
    const collapsed = collapse(actual);
    matrix[expected][collapsed] += 1;

    const isAbstention = collapsed === "ANALYSIS_ONLY" && expected !== "ANALYSIS_ONLY";

    if (expected !== "REPRODUCED") {
      negatives += 1;
      if (collapsed === "REPRODUCED") falsePositives += 1;
    } else {
      positives += 1;
      if (collapsed !== "REPRODUCED") falseNegatives += 1;
    }

    if (isAbstention) abstentions += 1;

    if (!isAbstention) {
      nonAbstainedTotal += 1;
      if (collapsed === expected) nonAbstainedCorrect += 1;
    }
  }

  return {
    total: results.length,
    matrix,
    falsePositiveRate: negatives === 0 ? 0 : falsePositives / negatives,
    invalidRecall: negatives === 0 ? 0 : 1 - falsePositives / negatives,
    falseNegativeRate: positives === 0 ? 0 : falseNegatives / positives,
    abstentionRate: abstentions / results.length,
    accuracyOnNonAbstained: nonAbstainedTotal === 0 ? 0 : nonAbstainedCorrect / nonAbstainedTotal,
  };
}

export type AggregateMetric = { mean: number; min: number; max: number };

export type AggregateScorecard = {
  runs: number;
  falsePositiveRate: AggregateMetric;
  invalidRecall: AggregateMetric;
  falseNegativeRate: AggregateMetric;
  abstentionRate: AggregateMetric;
  accuracyOnNonAbstained: AggregateMetric;
};

function aggregateOf(values: readonly number[]): AggregateMetric {
  return {
    mean: values.reduce((sum, v) => sum + v, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * Mean and min/max of each rate across repeated runs of the same corpus. The corpus is small
 * (30 cases, 20 negatives today), so a single run's rates are noisy; repeating the run and
 * reporting the spread is the honest way to report a number this sample size can actually carry.
 * See docs/benchmark.md for the confidence-interval caveat this is meant to surface.
 */
export function aggregate(scorecards: readonly Scorecard[]): AggregateScorecard {
  if (scorecards.length === 0) throw new Error("aggregate: no scorecards to aggregate");

  return {
    runs: scorecards.length,
    falsePositiveRate: aggregateOf(scorecards.map((s) => s.falsePositiveRate)),
    invalidRecall: aggregateOf(scorecards.map((s) => s.invalidRecall)),
    falseNegativeRate: aggregateOf(scorecards.map((s) => s.falseNegativeRate)),
    abstentionRate: aggregateOf(scorecards.map((s) => s.abstentionRate)),
    accuracyOnNonAbstained: aggregateOf(scorecards.map((s) => s.accuracyOnNonAbstained)),
  };
}
