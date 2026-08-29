import assert from "node:assert/strict";
import test from "node:test";

import { decideOutcome, type ReproductionRun } from "./decide";

const clean: ReproductionRun = {
  fixtureCompleted: true,
  negativeControlCompleted: true,
  negativeControlCanaryFound: false,
  exploitCompleted: true,
  exploitCanaryFound: false,
};

test("a completed run with a clean negative control and a found canary reproduces", () => {
  assert.equal(decideOutcome({ ...clean, exploitCanaryFound: true }), "REPRODUCED");
});

test("a completed run with a clean negative control and no canary found does not reproduce", () => {
  assert.equal(decideOutcome(clean), "NOT_REPRODUCED");
});

test("a fixture that never completed never produces a definitive verdict, even if both legs look clean", () => {
  assert.equal(
    decideOutcome({ ...clean, fixtureCompleted: false, exploitCanaryFound: true }),
    "ANALYSIS_ONLY",
  );
});

test("an incomplete negative control never produces a definitive verdict", () => {
  assert.equal(
    decideOutcome({ ...clean, negativeControlCompleted: false, exploitCanaryFound: true }),
    "ANALYSIS_ONLY",
  );
});

test("an incomplete exploit never produces a definitive verdict", () => {
  assert.equal(decideOutcome({ ...clean, exploitCompleted: false }), "ANALYSIS_ONLY");
});

test("a dirty negative control (canary found before the exploit ran) is never trusted", () => {
  assert.equal(
    decideOutcome({ ...clean, negativeControlCanaryFound: true, exploitCanaryFound: true }),
    "ANALYSIS_ONLY",
  );
});

test("everything incomplete is still ANALYSIS_ONLY, not a guess", () => {
  assert.equal(
    decideOutcome({
      fixtureCompleted: false,
      negativeControlCompleted: false,
      negativeControlCanaryFound: false,
      exploitCompleted: false,
      exploitCanaryFound: false,
    }),
    "ANALYSIS_ONLY",
  );
});
