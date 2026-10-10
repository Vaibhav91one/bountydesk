import assert from "node:assert/strict";
import test from "node:test";

import { aggregate, score, type CaseResult } from "./score";

function results(pairs: Array<[CaseResult["expected"], CaseResult["actual"]]>): CaseResult[] {
  return pairs.map(([expected, actual], i) => ({ id: `c${i}`, expected, actual }));
}

test("score: a perfect run has zero FPR/FNR, full invalid recall and accuracy, no abstention", () => {
  const card = score(
    results([
      ["REPRODUCED", "REPRODUCED"],
      ["REPRODUCED", "REPRODUCED"],
      ["NOT_REPRODUCED", "NOT_REPRODUCED"],
      ["ANALYSIS_ONLY", "ANALYSIS_ONLY"],
    ]),
  );

  assert.equal(card.falsePositiveRate, 0);
  assert.equal(card.invalidRecall, 1);
  assert.equal(card.falseNegativeRate, 0);
  assert.equal(card.abstentionRate, 0);
  assert.equal(card.accuracyOnNonAbstained, 1);
  assert.deepEqual(card.matrix.REPRODUCED, { REPRODUCED: 2, NOT_REPRODUCED: 0, ANALYSIS_ONLY: 0 });
  assert.deepEqual(card.matrix.NOT_REPRODUCED, { REPRODUCED: 0, NOT_REPRODUCED: 1, ANALYSIS_ONLY: 0 });
  assert.deepEqual(card.matrix.ANALYSIS_ONLY, { REPRODUCED: 0, NOT_REPRODUCED: 0, ANALYSIS_ONLY: 1 });
});

test("score: REPRODUCED claimed on a negative case counts as a false positive, not an abstention", () => {
  const card = score(
    results([
      ["NOT_REPRODUCED", "REPRODUCED"],
      ["NOT_REPRODUCED", "NOT_REPRODUCED"],
      ["ANALYSIS_ONLY", "REPRODUCED"],
    ]),
  );

  // 3 negative-type cases (NOT_REPRODUCED + ANALYSIS_ONLY ground truth), 2 of them scored REPRODUCED.
  assert.equal(card.falsePositiveRate, 2 / 3);
  assert.equal(card.invalidRecall, 1 - 2 / 3);
  assert.equal(card.abstentionRate, 0);
});

test("score: an abstention on a positive case is a false negative but not scored in accuracy", () => {
  const card = score(
    results([
      ["REPRODUCED", "ANALYSIS_ONLY"],
      ["REPRODUCED", "REPRODUCED"],
    ]),
  );

  assert.equal(card.falseNegativeRate, 0.5);
  assert.equal(card.abstentionRate, 0.5);
  // Only the non-abstained case (the second one, correct) counts toward accuracy.
  assert.equal(card.accuracyOnNonAbstained, 1);
});

test("score: an abstention on a negative case counts toward invalid recall, not false positives", () => {
  const card = score(
    results([
      ["NOT_REPRODUCED", "ANALYSIS_ONLY"],
      ["NOT_REPRODUCED", "NOT_REPRODUCED"],
    ]),
  );

  assert.equal(card.falsePositiveRate, 0);
  assert.equal(card.invalidRecall, 1);
  // abstaining on a negative does not cost accuracy either way: it is excluded, not wrong.
  assert.equal(card.abstentionRate, 0.5);
  assert.equal(card.accuracyOnNonAbstained, 1);
});

test("score: an actual INCONCLUSIVE is treated exactly like ANALYSIS_ONLY", () => {
  const withInconclusive = score(results([["REPRODUCED", "INCONCLUSIVE"]]));
  const withAnalysisOnly = score(results([["REPRODUCED", "ANALYSIS_ONLY"]]));

  assert.deepEqual(withInconclusive, withAnalysisOnly);
});

test("score: an expected ANALYSIS_ONLY case (unbound target) scored NOT_REPRODUCED is a mismatch, not an abstention", () => {
  const card = score(results([["ANALYSIS_ONLY", "NOT_REPRODUCED"]]));

  // Not an abstention definition match (ground truth itself was ANALYSIS_ONLY), so it is scored
  // as a plain miss on accuracy, with no FPR/FNR/abstention impact (it is neither a REPRODUCED
  // positive nor collapsed to ANALYSIS_ONLY).
  assert.equal(card.abstentionRate, 0);
  assert.equal(card.accuracyOnNonAbstained, 0);
});

test("score: throws on an empty run rather than reporting a misleadingly perfect 0/0", () => {
  assert.throws(() => score([]));
});

test("aggregate: reports mean and min/max across repeated runs", () => {
  const perfect = score(results([["REPRODUCED", "REPRODUCED"]]));
  const allFalsePositive = score(results([["NOT_REPRODUCED", "REPRODUCED"]]));
  const agg = aggregate([perfect, allFalsePositive]);

  assert.equal(agg.runs, 2);
  assert.equal(agg.falsePositiveRate.mean, 0.5);
  assert.equal(agg.falsePositiveRate.min, 0);
  assert.equal(agg.falsePositiveRate.max, 1);
});

test("aggregate: throws on no scorecards", () => {
  assert.throws(() => aggregate([]));
});
