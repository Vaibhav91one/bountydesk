import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Real Postgres, same reasoning as lib/delivery/queue.test.ts: SKIP LOCKED and the fenced
 * compare-and-swap are guarantees the database provides, and a mock would happily agree with
 * a broken implementation of either.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

type QueueModule = typeof import("./queue");
type DbModule = typeof import("@/lib/db");

let queue: QueueModule;
let dbm: DbModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("agent_sessions_queue");

  dbm = await import("@/lib/db");
  queue = await import("./queue");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function seedSession(
  overrides: Partial<{ turnId: string | null; turnStatus: string }> = {},
) {
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

  const [s] = await dbm.db
    .insert(dbm.agentSession)
    .values({
      reportId: r.id,
      capabilityToken: `cap-${n}`,
      sessionId: `session-${n}`,
      turnId: overrides.turnId ?? `turn-${n}`,
      ...(overrides.turnStatus ? { turnStatus: overrides.turnStatus } : {}),
    })
    .returning({ id: dbm.agentSession.id });

  return { reportId: r.id, agentSessionId: s.id };
}

/**
 * claim() is global, taking the oldest claimable row in the whole table, so a test that
 * seeds its own row is still not guaranteed to be handed it if an earlier test's row is
 * still pollable. Marking everything terminal makes "the row I just seeded" the only
 * claimable thing left.
 */
async function drainOthers() {
  await dbm.db
    .update(dbm.agentSession)
    .set({ turnStatus: "DONE_NO_ACTION", leaseOwner: null, leaseExpiresAt: null });
}

test("SKIP LOCKED means a second claim does not block on a locked row", async () => {
  await drainOthers();
  await seedSession();
  await seedSession();

  const holder = await schema.admin.reserve();
  await holder.unsafe(`set search_path to "${schema.name}"`);
  await holder.unsafe("begin");
  const [locked] = await holder.unsafe(
    `select id from agent_session where turn_status not in ('DONE_NO_ACTION','ERROR','CANCELLED') order by next_poll_at limit 1 for update`,
  );

  try {
    const claimed = await Promise.race([
      queue.claim("worker-b", 60),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("claim blocked on a locked row")), 4000),
      ),
    ]);

    assert.ok(claimed, "a second session should have been available");
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

test("a stale fence cannot mutate a session once another worker reclaims it", async () => {
  await drainOthers();
  const seeded = await seedSession();

  const stale = await queue.claim("worker-stale", 60);
  assert.ok(stale);
  assert.equal(stale.id, seeded.agentSessionId);
  assert.ok(stale.fence > 0, "a claim must issue a fence token");

  // Expire the lease, as if this worker had stalled past it.
  await dbm.db
    .update(dbm.agentSession)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.agentSession.id, stale.id));

  const fresh = await queue.claim("worker-fresh", 60);
  assert.ok(fresh);
  assert.equal(fresh.id, stale.id, "the abandoned row should have been reclaimed");
  assert.ok(fresh.fence > stale.fence, "reclaiming must issue a newer fence");

  // The stale worker comes back and tries to act on a lease it no longer holds.
  await assert.rejects(
    () => queue.release(stale, { turnStatus: "RUNNING" }),
    queue.LeaseLostError,
  );
  await assert.rejects(() => queue.renew(stale, 30), queue.LeaseLostError);

  // The rightful holder is unaffected.
  await queue.release(fresh, { turnStatus: "DONE_NO_ACTION" });
});

test("an expired lease is reclaimed by sweepExpiredLeases", async () => {
  await drainOthers();
  const seeded = await seedSession();

  const lease = await queue.claim("worker-expiring", 60);
  assert.ok(lease);
  assert.equal(lease.id, seeded.agentSessionId);

  await dbm.db
    .update(dbm.agentSession)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.agentSession.id, lease.id));

  const swept = await queue.sweepExpiredLeases();
  assert.ok(swept.released >= 1, "an expired lease must be cleared for reclaiming");

  const reclaimed = await queue.claim("worker-after-sweep", 60);
  assert.ok(reclaimed);
  assert.equal(reclaimed.id, seeded.agentSessionId);
});

test("release writes only the columns the caller passes and always drops the lease", async () => {
  await drainOthers();
  const seeded = await seedSession();
  const expectedSessionId = `session-${seq}`;

  // The pending_* columns are all-or-none at the database level (see schema.ts), so a
  // verdict has to exist to populate pendingVerdictId.
  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: seeded.reportId,
      outcome: "REPRODUCED",
      summary: "summary",
      payload: "payload",
      contentHash: "hash-1",
    })
    .returning({ id: dbm.verdict.id });

  const lease = await queue.claim("worker-partial", 60);
  assert.ok(lease);

  await queue.release(lease, {
    turnStatus: "AWAITING_APPROVAL_HARNESS",
    pendingThreadId: "thread-1",
    pendingToolCallId: "call-1",
    pendingVerdictId: v.id,
    pendingApprovedContentHash: "hash-1",
  });

  const [row] = await dbm.db
    .select({
      turnStatus: dbm.agentSession.turnStatus,
      pendingThreadId: dbm.agentSession.pendingThreadId,
      pendingVerdictId: dbm.agentSession.pendingVerdictId,
      leaseOwner: dbm.agentSession.leaseOwner,
      sessionId: dbm.agentSession.sessionId,
    })
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.id, seeded.agentSessionId));

  assert.equal(row.turnStatus, "AWAITING_APPROVAL_HARNESS");
  assert.equal(row.pendingThreadId, "thread-1");
  assert.equal(row.pendingVerdictId, v.id);
  assert.equal(row.leaseOwner, null);
  // sessionId was never part of the update, so it must be untouched.
  assert.equal(row.sessionId, expectedSessionId);
});

test("a terminal turnStatus is not claimable", async () => {
  await drainOthers();
  await seedSession({ turnStatus: "ERROR" });

  assert.equal(await queue.claim("worker-terminal", 60), null);
});
