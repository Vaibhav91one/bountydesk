import assert from "node:assert/strict";
import { test } from "node:test";

import type { CaseLiveView } from "./case-view";
import { caseRefetchInterval, listRefetchInterval, toolCallsRefetchInterval } from "./status-query";

/**
 * The poll has to stop on its own. A tab left open on a finished report asking the database
 * every 1.5 seconds forever is the failure mode these cover.
 */

function view(overrides: Partial<CaseLiveView> = {}): CaseLiveView {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    state: "TRIAGING",
    phase: "triaging",
    stateLabel: "Triaging",
    updatedAt: "2026-08-31T12:00:00.000Z",
    mascotKey: "ingest",
    investigating: false,
    turnStatus: null,
    sessionError: null,
    failed: false,
    eventCount: 0,
    deliveryState: null,
    verdictOutcome: null,
    outcomeLabel: null,
    showOutcomeBadge: false,
    approvalDecision: null,
    awaitingVerdictId: null,
    target: null,
    sandbox: null,
    finalSummary: null,
    destination: "#18",
    verdict: null,
    approval: null,
    delivery: null,
    handoff: null,
    steps: [],
    artifacts: [],
    ...overrides,
  };
}

const delivery = (overrides: Partial<NonNullable<CaseLiveView["delivery"]>>) => ({
  state: "PENDING",
  attempts: 0,
  maxAttempts: 8,
  lastError: null,
  target: "issues/18",
  ...overrides,
});

test("a run in flight polls fast", () => {
  assert.equal(caseRefetchInterval(view({ state: "TRIAGING" })), 1500);
  assert.equal(caseRefetchInterval(view({ state: "ANALYSIS_ONLY" })), 1500);
  assert.equal(caseRefetchInterval(view({ state: "DELIVERING" })), 1500);
});

test("a report waiting on a human polls slowly", () => {
  // Nothing moves until somebody clicks, and that click writes the decision into the cache
  // directly, so the poll behind it is only there to pick up what the server derives.
  assert.equal(caseRefetchInterval(view({ state: "AWAITING_APPROVAL" })), 5000);
});

test("a finished report stops polling", () => {
  for (const state of ["DELIVERED", "DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"]) {
    assert.equal(caseRefetchInterval(view({ state })), false, state);
  }
});

test("a queued send keeps polling even once the report is terminal", () => {
  assert.equal(
    caseRefetchInterval(
      view({ state: "DELIVERED", delivery: delivery({ state: "PENDING" }) }),
    ),
    1500,
  );
});

test("a delivery stops being watched once it has run out of attempts", () => {
  const retrying = view({
    state: "DELIVERING",
    delivery: delivery({ state: "FAILED", attempts: 3, maxAttempts: 8 }),
  });
  assert.equal(caseRefetchInterval(retrying), 1500, "the outbox will try again");

  const exhausted = view({
    state: "DELIVERING",
    delivery: delivery({ state: "FAILED", attempts: 8, maxAttempts: 8 }),
  });
  assert.equal(caseRefetchInterval(exhausted), false, "nothing will pick this row up again");
});

test("tool-call detail is only fetched while the agent is working", () => {
  assert.equal(toolCallsRefetchInterval(view({ investigating: true })), 5000);
  assert.equal(toolCallsRefetchInterval(view({ investigating: false })), false);
});

test("a list stops polling once every row on it has stopped moving", () => {
  assert.equal(listRefetchInterval(["DELIVERED", "AWAITING_APPROVAL"]), 4000);
  assert.equal(listRefetchInterval(["DELIVERED", "DENIED"]), false);
});

const handoff = (overrides: Partial<NonNullable<CaseLiveView["handoff"]>>) => ({
  state: "PENDING",
  attempts: 0,
  maxAttempts: 8,
  lastError: null,
  ...overrides,
});

test("a handoff that ran out of attempts stops the poll", () => {
  // The report stays AWAITING_APPROVAL forever, so without this rule it is asked about every
  // 1.5 seconds for as long as the tab is open, waiting on a delivery nothing will enqueue.
  const dead = view({
    state: "AWAITING_APPROVAL",
    handoff: handoff({ state: "FAILED", attempts: 8 }),
  });
  assert.equal(caseRefetchInterval(dead), false);

  const retrying = view({
    state: "AWAITING_APPROVAL",
    handoff: handoff({ state: "FAILED", attempts: 3 }),
  });
  assert.equal(caseRefetchInterval(retrying), 5000, "still worth watching");

  // A delivery exists, so the handoff got through and its stale FAILED means nothing.
  const delivered = view({
    state: "DELIVERING",
    handoff: handoff({ state: "FAILED", attempts: 8 }),
    delivery: {
      state: "SENT",
      attempts: 1,
      maxAttempts: 8,
      lastError: null,
      target: "issues/18",
    },
  });
  assert.equal(caseRefetchInterval(delivered), 1500);
});

test("an empty list keeps polling, because the first report has to arrive somehow", () => {
  assert.equal(listRefetchInterval([]), 4000);
});
