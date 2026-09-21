import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_RETRY_DELAY_MS,
  MAX_BACKOFF_MS,
  SECOND_RETRY_DELAY_MS,
  THIRD_RETRY_DELAY_MS,
  backoffMs,
  shouldDeadLetter,
} from "./backoff";

test("attempt one gives the smallest delay", () => {
  assert.equal(backoffMs(1), FIRST_RETRY_DELAY_MS);
  assert.equal(FIRST_RETRY_DELAY_MS, 30_000);
});

test("delays grow exponentially and match the documented schedule", () => {
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), SECOND_RETRY_DELAY_MS);
  assert.equal(backoffMs(2), 120_000);
  assert.equal(backoffMs(3), THIRD_RETRY_DELAY_MS);
  assert.equal(backoffMs(3), 300_000);
  assert.equal(backoffMs(4), MAX_BACKOFF_MS);
  assert.equal(backoffMs(4), 900_000);
});

test("delays are monotonic and capped", () => {
  const seen = [1, 2, 3, 4, 5, 6, 10, 100].map((attempt) => backoffMs(attempt));
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] >= seen[i - 1], `attempt ${i + 1} must not be sooner`);
  }
  assert.equal(backoffMs(5), MAX_BACKOFF_MS);
  assert.equal(backoffMs(100), MAX_BACKOFF_MS);
});

test("bad input falls back to the smallest delay", () => {
  assert.equal(backoffMs(0), FIRST_RETRY_DELAY_MS);
  assert.equal(backoffMs(-3), FIRST_RETRY_DELAY_MS);
  assert.equal(backoffMs(Number.NaN), FIRST_RETRY_DELAY_MS);
});

test("dead letter once attempts reach the budget", () => {
  assert.equal(shouldDeadLetter(4, 5), false);
  assert.equal(shouldDeadLetter(5, 5), true);
  assert.equal(shouldDeadLetter(6, 5), true);
});
