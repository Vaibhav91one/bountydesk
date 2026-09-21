import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5432/postgres";

/**
 * Pure decision coverage for the stuck recheck sweeper in ./queue. The database
 * predicate in sweepRecheckRuns mirrors recheckSweepReason, so fixtures here prove
 * the boundary without a run row.
 */
test("a never claimed pending run past its timeout is swept", async () => {
  const { RECHECK_PENDING_TIMEOUT_MS, recheckSweepReason } = await import("./queue");
  const now = new Date("2026-09-21T10:00:00Z");

  assert.equal(
    recheckSweepReason(
      {
        reason: "REVIEWER_GUIDANCE",
        status: "PENDING",
        attempts: 0,
        createdAt: new Date(now.getTime() - RECHECK_PENDING_TIMEOUT_MS - 1000),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      now,
    ),
    "pending re-check was not claimed before its timeout",
  );
});

test("a fresh pending run is left alone", async () => {
  const { recheckSweepReason } = await import("./queue");
  const now = new Date("2026-09-21T10:00:00Z");

  assert.equal(
    recheckSweepReason(
      {
        reason: "REVIEWER_GUIDANCE",
        status: "PENDING",
        attempts: 0,
        createdAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      now,
    ),
    null,
  );
});

test("a pending run that spent its claim budget is swept", async () => {
  const { RECHECK_MAX_ATTEMPTS, recheckSweepReason } = await import("./queue");
  const now = new Date("2026-09-21T10:00:00Z");

  assert.equal(
    recheckSweepReason(
      {
        reason: "REVIEWER_GUIDANCE",
        status: "PENDING",
        attempts: RECHECK_MAX_ATTEMPTS,
        createdAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      now,
    ),
    "re-check claim attempt limit reached",
  );
});

test("an expired running run at its budget is swept", async () => {
  const { RECHECK_MAX_ATTEMPTS, recheckSweepReason } = await import("./queue");
  const now = new Date("2026-09-21T10:00:00Z");

  assert.equal(
    recheckSweepReason(
      {
        reason: "REVIEWER_GUIDANCE",
        status: "RUNNING",
        attempts: RECHECK_MAX_ATTEMPTS,
        createdAt: new Date(now.getTime() - 60_000),
        leaseOwner: "worker-a",
        leaseExpiresAt: new Date(now.getTime() - 1000),
      },
      now,
    ),
    "re-check claim attempt limit reached after lease expiry",
  );
});

test("a running run with budget left or a live lease is left alone", async () => {
  const { RECHECK_MAX_ATTEMPTS, recheckSweepReason } = await import("./queue");
  const now = new Date("2026-09-21T10:00:00Z");

  assert.equal(
    recheckSweepReason(
      {
        reason: "REVIEWER_GUIDANCE",
        status: "RUNNING",
        attempts: 1,
        createdAt: new Date(now.getTime() - 60_000),
        leaseOwner: "worker-a",
        leaseExpiresAt: new Date(now.getTime() - 1000),
      },
      now,
    ),
    null,
  );
  assert.equal(
    recheckSweepReason(
      {
        reason: "REVIEWER_GUIDANCE",
        status: "RUNNING",
        attempts: RECHECK_MAX_ATTEMPTS,
        createdAt: new Date(now.getTime() - 60_000),
        leaseOwner: "worker-a",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      },
      now,
    ),
    null,
  );
});

test("other reasons and finished states are never swept", async () => {
  const { recheckSweepReason } = await import("./queue");
  const now = new Date("2026-09-21T10:00:00Z");

  assert.equal(
    recheckSweepReason(
      {
        reason: "INITIAL",
        status: "PENDING",
        attempts: 99,
        createdAt: new Date(0),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      now,
    ),
    null,
  );
  assert.equal(
    recheckSweepReason(
      {
        reason: "REVIEWER_GUIDANCE",
        status: "DONE",
        attempts: 99,
        createdAt: new Date(0),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      now,
    ),
    null,
  );
});
