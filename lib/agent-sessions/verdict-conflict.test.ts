import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5432/postgres";

/**
 * Pure decision coverage for the poison redraft guard in ./queue. No database is
 * touched: the helpers branch only on the error value and the attempts count, so
 * in memory fixtures prove the boundary without a claim row.
 */
test("a payload integrity error is a verdict conflict", async () => {
  const { isVerdictIntegrityConflict } = await import("./queue");
  const { VerdictIntegrityError } = await import("@/lib/verdicts/lifecycle");

  assert.equal(
    isVerdictIntegrityConflict(new VerdictIntegrityError("report-1", "payload")),
    true,
  );
});

test("the typed error counts even for a non payload mismatch", async () => {
  const { isVerdictIntegrityConflict } = await import("./queue");
  const { VerdictIntegrityError } = await import("@/lib/verdicts/lifecycle");

  assert.equal(
    isVerdictIntegrityConflict(new VerdictIntegrityError("report-1", "outcome")),
    true,
  );
});

test("a message shaped like the error counts when the prototype was lost", async () => {
  const { isVerdictIntegrityConflict } = await import("./queue");

  assert.equal(
    isVerdictIntegrityConflict(
      new Error("verdict for report abc already exists and disagrees on payload"),
    ),
    true,
  );
});

test("unrelated errors are not verdict conflicts", async () => {
  const { isVerdictIntegrityConflict } = await import("./queue");

  assert.equal(isVerdictIntegrityConflict(new Error("connection reset")), false);
  assert.equal(isVerdictIntegrityConflict("verdict for report abc"), false);
  assert.equal(isVerdictIntegrityConflict(null), false);
  assert.equal(
    isVerdictIntegrityConflict(
      new Error("verdict for report abc already exists and disagrees on outcome"),
    ),
    false,
  );
});

test("abandon waits for the named attempt limit", async () => {
  const { MAX_CONSECUTIVE_CLAIM_FAILURES, shouldAbandonVerdictConflict } =
    await import("./queue");

  assert.equal(shouldAbandonVerdictConflict(0), false);
  assert.equal(
    shouldAbandonVerdictConflict(MAX_CONSECUTIVE_CLAIM_FAILURES - 1),
    false,
  );
  assert.equal(
    shouldAbandonVerdictConflict(MAX_CONSECUTIVE_CLAIM_FAILURES),
    true,
  );
  assert.equal(
    shouldAbandonVerdictConflict(MAX_CONSECUTIVE_CLAIM_FAILURES + 1),
    true,
  );
});
