import assert from "node:assert/strict";
import test from "node:test";

import { buildScorecard, renderScorecard } from "./scorecard";

const cases = [
  { id: "p1", kind: "positive", vulnClass: "injection", negativeType: undefined },
  { id: "n1", kind: "negative", vulnClass: "injection", negativeType: "duplicate" },
  { id: "p2", kind: "positive", vulnClass: "xss", negativeType: undefined },
  { id: "n2", kind: "negative", vulnClass: "xss", negativeType: "wrong-payload" },
] as const;

test("buildScorecard: reports the overall card and a card per vulnerability class from a results file", () => {
  const card = buildScorecard(
    [
      { id: "p1", expected: "REPRODUCED", actual: "REPRODUCED" },
      { id: "n1", expected: "NOT_REPRODUCED", actual: "NOT_REPRODUCED" },
      { id: "p2", expected: "REPRODUCED", actual: "ANALYSIS_ONLY" },
      { id: "n2", expected: "NOT_REPRODUCED", actual: "REPRODUCED" },
    ],
    cases,
  );

  assert.equal(card.overall.total, 4);
  assert.equal(card.byClass.injection.falsePositiveRate, 0);
  assert.equal(card.byClass.xss.falsePositiveRate, 1);
  assert.equal(card.byClass.xss.falseNegativeRate, 1);
});

test("buildScorecard: a result for a case id the corpus does not know is an error, not silently dropped", () => {
  assert.throws(
    () => buildScorecard([{ id: "ghost", expected: "REPRODUCED", actual: "REPRODUCED" }], cases),
    /ghost/,
  );
});

test("renderScorecard: prints one row per class with the headline rates as percentages", () => {
  const card = buildScorecard(
    [
      { id: "p1", expected: "REPRODUCED", actual: "REPRODUCED" },
      { id: "n1", expected: "NOT_REPRODUCED", actual: "REPRODUCED" },
    ],
    cases,
  );
  const text = renderScorecard(card);

  assert.match(text, /overall/i);
  assert.match(text, /injection\s+2\s+100\.0%/);
});
