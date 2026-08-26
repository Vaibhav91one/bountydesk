import assert from "node:assert/strict";
import test from "node:test";

import { TERMINAL_STATES, canTransition, isTerminal, type ReportState } from "./states";

/**
 * The transition graph on its own. No database: this is the part that decides whether a
 * report can go somewhere, and it should be readable without one.
 */
test("the five terminal states go nowhere", () => {
  for (const state of TERMINAL_STATES) {
    assert.equal(isTerminal(state), true, state);

    for (const to of ["TRIAGING", "REPRODUCING", "AWAITING_APPROVAL", "CANCELLED"] as const) {
      assert.equal(canTransition(state, to), false, `${state} -> ${to}`);
    }
  }
});

test("the happy path is legal end to end", () => {
  const path: ReportState[] = [
    "TRIAGING",
    "REPRODUCING",
    "AWAITING_APPROVAL",
    "DELIVERING",
    "DELIVERED",
  ];

  for (let i = 0; i < path.length - 1; i++) {
    assert.equal(canTransition(path[i], path[i + 1]), true, `${path[i]} -> ${path[i + 1]}`);
  }
});

test("out of scope is a pre-verdict rejection only", () => {
  assert.equal(canTransition("TRIAGING", "OUT_OF_SCOPE"), true);

  // Once a report has been reproduced, refusing it is a human decision, not a scope check.
  assert.equal(canTransition("REPRODUCING", "OUT_OF_SCOPE"), false);
  assert.equal(canTransition("AWAITING_APPROVAL", "OUT_OF_SCOPE"), false);
});

test("the analysis packet still goes through the human gate", () => {
  assert.equal(canTransition("TRIAGING", "ANALYSIS_ONLY"), true);
  assert.equal(canTransition("REPRODUCING", "ANALYSIS_ONLY"), true);
  assert.equal(canTransition("ANALYSIS_ONLY", "AWAITING_APPROVAL"), true);

  // Nothing reaches a reporter without approval, analysis included.
  assert.equal(canTransition("ANALYSIS_ONLY", "DELIVERING"), false);
  assert.equal(canTransition("ANALYSIS_ONLY", "DELIVERED"), false);
});

test("approval is the only way into delivery", () => {
  assert.equal(canTransition("AWAITING_APPROVAL", "DELIVERING"), true);
  assert.equal(canTransition("AWAITING_APPROVAL", "DENIED"), true);

  for (const from of ["TRIAGING", "REPRODUCING", "ANALYSIS_ONLY"] as const) {
    assert.equal(canTransition(from, "DELIVERING"), false, from);
    assert.equal(canTransition(from, "DELIVERED"), false, from);
  }
});

test("steps cannot be skipped", () => {
  assert.equal(canTransition("TRIAGING", "AWAITING_APPROVAL"), false);
  assert.equal(canTransition("REPRODUCING", "DELIVERING"), false);
  assert.equal(canTransition("DELIVERING", "DENIED"), false);
});

test("any live report can be cancelled or expire", () => {
  for (const from of [
    "TRIAGING",
    "REPRODUCING",
    "ANALYSIS_ONLY",
    "AWAITING_APPROVAL",
    "DELIVERING",
  ] as const) {
    assert.equal(canTransition(from, "CANCELLED"), true, from);
    assert.equal(canTransition(from, "EXPIRED"), true, from);
  }
});

test("DEAD_LETTER is not a report state", () => {
  // Job execution owns that value. If this ever compiles with it, the two enums have been
  // conflated somewhere.
  assert.equal((TERMINAL_STATES as readonly string[]).includes("DEAD_LETTER"), false);
});
