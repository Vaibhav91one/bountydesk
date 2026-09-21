import assert from "node:assert/strict";
import test from "node:test";

import {
  deadLetterReasonFor,
  INTAKE_STALE_MS,
  intakeLabelFor,
  mapIntakeRow,
  shouldShowIntakeJob,
  visibleIntakeJobs,
  type IntakeJobRow,
  type IntakeJobView,
} from "./jobs-read";

/**
 * In-memory fixtures only. The mapping under test never touches the database, so
 * these must not need one either: no schema setup, no DATABASE_URL.
 */
const NOW = new Date("2026-09-21T12:00:00.000Z").getTime();

function row(over: Partial<IntakeJobRow> = {}): IntakeJobRow {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    channel: "github",
    state: "RECEIVED",
    deliveryId: "abcdef1234567890",
    reportId: null,
    attempts: 0,
    maxAttempts: 5,
    lastError: null,
    createdAt: new Date(NOW - 6 * 60 * 1000),
    updatedAt: new Date(NOW - 6 * 60 * 1000),
    sourceRef: null,
    repoFullName: null,
    ...over,
  };
}

function view(over: Partial<IntakeJobView> = {}): IntakeJobView {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    channel: "github",
    state: "RECEIVED",
    deliveryPrefix: "abcdef12",
    reportId: null,
    attempts: 0,
    maxAttempts: 5,
    receivedAt: new Date(NOW - 6 * 60 * 1000).toISOString(),
    updatedAt: new Date(NOW - 6 * 60 * 1000).toISOString(),
    ageLabel: "6m",
    label: null,
    reason: null,
    ...over,
  };
}

test("the label joins the repo short name to the issue number", () => {
  assert.equal(
    intakeLabelFor("github:123456:issue:25", "Vaibhav91one/juice-shop"),
    "juice-shop #25",
  );
});

test("the label falls back to the bare issue number without a repo name", () => {
  assert.equal(intakeLabelFor("github:123456:issue:25", null), "#25");
});

test("the label is null when there is nothing safe to derive it from", () => {
  assert.equal(intakeLabelFor(null, "Vaibhav91one/juice-shop"), null);
  assert.equal(intakeLabelFor("email:reporter@example.com", "Vaibhav91one/juice-shop"), null);
  assert.equal(intakeLabelFor("github:not-an-issue", "Vaibhav91one/juice-shop"), null);
});

test("only a dead-lettered job carries a reason, bounded to one line", () => {
  assert.equal(deadLetterReasonFor("RUNNING", "boom"), null);
  assert.equal(deadLetterReasonFor("DEAD_LETTER", null), null);
  assert.equal(deadLetterReasonFor("DEAD_LETTER", "   "), null);
  assert.equal(deadLetterReasonFor("DEAD_LETTER", "worker died"), "worker died");

  const long = "x".repeat(200);
  const reason = deadLetterReasonFor("DEAD_LETTER", long);
  assert.equal(reason?.length, 120);
});

test("the mapper keeps the wire shape payload free", () => {
  const mapped = mapIntakeRow(
    row({
      deliveryId: "abcdef1234567890",
      sourceRef: "github:123456:issue:25",
      repoFullName: "Vaibhav91one/juice-shop",
      lastError: "worker died",
      state: "DEAD_LETTER",
    }),
    NOW,
  );

  assert.equal(mapped.deliveryPrefix, "abcdef12");
  assert.equal(mapped.label, "juice-shop #25");
  assert.equal(mapped.reason, "worker died");
  assert.equal(mapped.receivedAt, new Date(NOW - 6 * 60 * 1000).toISOString());
  assert.equal(mapped.ageLabel, "6m");
  for (const key of ["payload", "title", "body"]) {
    assert.ok(!(key in mapped), `${key} must never cross into the strip`);
  }
});

test("finished jobs never show, failed and running ones always do", () => {
  assert.equal(shouldShowIntakeJob(view({ state: "DONE" }), NOW), false);
  assert.equal(
    shouldShowIntakeJob(view({ state: "DEAD_LETTER" }), NOW),
    true,
  );
  assert.equal(
    shouldShowIntakeJob(view({ state: "RUNNING" }), NOW),
    true,
  );
  assert.equal(
    shouldShowIntakeJob(view({ state: "SESSION_CREATED" }), NOW),
    true,
  );
});

test("a fresh RECEIVED row is queueing, a stale one is news", () => {
  const fresh = view({
    state: "RECEIVED",
    receivedAt: new Date(NOW - 60 * 1000).toISOString(),
  });
  const stale = view({
    state: "RECEIVED",
    receivedAt: new Date(NOW - INTAKE_STALE_MS - 1000).toISOString(),
  });
  const staleParsed = view({
    state: "PARSED",
    receivedAt: new Date(NOW - INTAKE_STALE_MS - 1000).toISOString(),
  });

  assert.equal(shouldShowIntakeJob(fresh, NOW), false);
  assert.equal(shouldShowIntakeJob(stale, NOW), true);
  assert.equal(shouldShowIntakeJob(staleParsed, NOW), true);
});

test("the visible set drops finished and fresh rows together", () => {
  const jobs = [
    view({ state: "DONE" }),
    view({ state: "RECEIVED", receivedAt: new Date(NOW - 1000).toISOString() }),
    view({ state: "DEAD_LETTER" }),
  ];
  assert.deepEqual(
    visibleIntakeJobs(jobs, NOW).map((job) => job.state),
    ["DEAD_LETTER"],
  );
});

test("a dead letter reason never carries a bearer token from the worker's error", () => {
  const reason = deadLetterReasonFor("DEAD_LETTER", "upstream failed: Bearer abc123def456ghi789 rejected");
  assert.ok(reason);
  assert.ok(!reason.includes("abc123def456ghi789"));
});
