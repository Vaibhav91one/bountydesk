import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Real Postgres, same reasoning as lib/delivery/queue.test.ts: SKIP LOCKED, the fenced
 * compare-and-swap, and the backoff formula are guarantees the database provides.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

type QueueModule = typeof import("./queue");
type DbModule = typeof import("@/lib/db");

let queue: QueueModule;
let dbm: DbModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("approval_submission_queue");

  dbm = await import("@/lib/db");
  queue = await import("./queue");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

/**
 * agent_session, verdict, and approval_decision seeded directly: this module tests
 * submission-queue mechanics, not how a decision gets recorded, and there is no production
 * path yet that produces all four rows together (see AGENTS.md on this batch of PRs).
 */
async function seedSubmission() {
  seq += 1;
  const n = seq;

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:1:issue:${n}`,
      title: `report ${n}`,
      body: "body",
    })
    .returning({ id: dbm.report.id });

  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: r.id,
      outcome: "REPRODUCED",
      summary: "summary",
      payload: `payload ${n}`,
      contentHash: `hash-${n}`,
    })
    .returning({ id: dbm.verdict.id });

  const [session] = await dbm.db
    .insert(dbm.agentSession)
    .values({
      reportId: r.id,
      capabilityToken: `cap-${n}`,
      sessionId: `session-${n}`,
      turnId: `turn-${n}`,
    })
    .returning({ id: dbm.agentSession.id });

  const [decision] = await dbm.db
    .insert(dbm.approvalDecision)
    .values({
      verdictId: v.id,
      reviewer: "test-reviewer",
      decision: "APPROVED",
      payloadHash: `hash-${n}`,
      threadId: `thread-${n}`,
      toolCallId: `call-${n}`,
    })
    .returning({ id: dbm.approvalDecision.id });

  const [submission] = await dbm.db
    .insert(dbm.approvalSubmission)
    .values({
      agentSessionId: session.id,
      approvalDecisionId: decision.id,
    })
    .returning({ id: dbm.approvalSubmission.id });

  return {
    agentSessionId: session.id,
    approvalDecisionId: decision.id,
    submissionId: submission.id,
  };
}

/** claim() is global; retire every other row first (see lib/delivery/queue.test.ts). */
async function drainOthers() {
  await dbm.db
    .update(dbm.approvalSubmission)
    .set({ state: "SUBMITTED", leaseOwner: null, leaseExpiresAt: null });
}

test("SKIP LOCKED means a second claim does not block on a locked row", async () => {
  await drainOthers();
  await seedSubmission();
  await seedSubmission();

  const holder = await schema.admin.reserve();
  await holder.unsafe(`set search_path to "${schema.name}"`);
  await holder.unsafe("begin");
  const [locked] = await holder.unsafe(
    `select id from approval_submission where state in ('PENDING','FAILED') order by next_attempt_at limit 1 for update`,
  );

  try {
    const claimed = await Promise.race([
      queue.claim("worker-b", 60),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("claim blocked on a locked row")), 4000),
      ),
    ]);

    assert.ok(claimed, "a second submission should have been available");
    assert.notEqual(
      claimed.id,
      locked.id,
      "the locked row must have been skipped, not returned",
    );
  } finally {
    await holder.unsafe("rollback");
    holder.release();
  }
});

test("a stale fence cannot mutate a submission once another worker reclaims it", async () => {
  await drainOthers();
  const seeded = await seedSubmission();

  const stale = await queue.claim("worker-stale", 60);
  assert.ok(stale);
  assert.equal(stale.id, seeded.submissionId);
  assert.ok(stale.fence > 0, "a claim must issue a fence token");

  await dbm.db
    .update(dbm.approvalSubmission)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.approvalSubmission.id, stale.id));

  const fresh = await queue.claim("worker-fresh", 60);
  assert.ok(fresh);
  assert.equal(fresh.id, stale.id, "the abandoned row should have been reclaimed");
  assert.ok(fresh.fence > stale.fence, "reclaiming must issue a newer fence");

  await assert.rejects(
    () => queue.markSubmitted(stale, "turn-x"),
    queue.LeaseLostError,
  );
  await assert.rejects(() => queue.fail(stale, "boom"), queue.LeaseLostError);
  await assert.rejects(() => queue.renew(stale, 30), queue.LeaseLostError);

  await queue.markSubmitted(fresh, "turn-y");
});

test("an expired lease is reclaimed by sweepExpiredLeases", async () => {
  await drainOthers();
  const seeded = await seedSubmission();

  const lease = await queue.claim("worker-expiring", 60);
  assert.ok(lease);
  assert.equal(lease.id, seeded.submissionId);

  await dbm.db
    .update(dbm.approvalSubmission)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.approvalSubmission.id, lease.id));

  const swept = await queue.sweepExpiredLeases();
  assert.ok(swept.released >= 1, "an expired lease must be cleared for reclaiming");

  const reclaimed = await queue.claim("worker-after-sweep", 60);
  assert.ok(reclaimed);
  assert.equal(reclaimed.id, seeded.submissionId);
});

test("markSubmitted records the acknowledged turn and drops the lease", async () => {
  await drainOthers();
  const seeded = await seedSubmission();

  const lease = await queue.claim("worker-submit", 60);
  assert.ok(lease);

  await queue.markSubmitted(lease, "turn-123");

  const [row] = await dbm.db
    .select({
      state: dbm.approvalSubmission.state,
      submittedTurnId: dbm.approvalSubmission.submittedTurnId,
      leaseOwner: dbm.approvalSubmission.leaseOwner,
    })
    .from(dbm.approvalSubmission)
    .where(dbm.eq(dbm.approvalSubmission.id, seeded.submissionId));

  assert.equal(row.state, "SUBMITTED");
  assert.equal(row.submittedTurnId, "turn-123");
  assert.equal(row.leaseOwner, null);
});

test("fail() backs off and only reaches FAILED once MAX_ATTEMPTS is exhausted", async () => {
  await drainOthers();
  const seeded = await seedSubmission();

  for (let attempt = 1; attempt < queue.MAX_ATTEMPTS; attempt++) {
    await dbm.db
      .update(dbm.approvalSubmission)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(dbm.eq(dbm.approvalSubmission.id, seeded.submissionId));

    const lease = await queue.claim(`worker-retry-${attempt}`, 60);
    assert.ok(lease);
    assert.equal(lease.attempts, attempt);

    await queue.fail(lease, `attempt ${attempt} failed`);

    const [row] = await dbm.db
      .select({ state: dbm.approvalSubmission.state })
      .from(dbm.approvalSubmission)
      .where(dbm.eq(dbm.approvalSubmission.id, seeded.submissionId));
    assert.equal(row.state, "PENDING", "attempts remain, so the row stays retryable");
  }

  await dbm.db
    .update(dbm.approvalSubmission)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.approvalSubmission.id, seeded.submissionId));

  const finalLease = await queue.claim("worker-final", 60);
  assert.ok(finalLease);
  assert.equal(finalLease.attempts, queue.MAX_ATTEMPTS);

  await queue.fail(finalLease, "final failure");

  const [row] = await dbm.db
    .select({ state: dbm.approvalSubmission.state, lastError: dbm.approvalSubmission.lastError })
    .from(dbm.approvalSubmission)
    .where(dbm.eq(dbm.approvalSubmission.id, seeded.submissionId));
  assert.equal(row.state, "FAILED");
  assert.equal(row.lastError, "final failure");

  assert.equal(await queue.claim("worker-after-exhausted", 60), null);
});
