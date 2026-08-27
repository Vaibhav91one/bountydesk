import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Real Postgres, same reasoning as lib/jobs/queue.test.ts: SKIP LOCKED, the fenced
 * compare-and-swap, and the backoff formula are guarantees the database provides, and a mock
 * would happily agree with a broken implementation of any of them.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

type QueueModule = typeof import("./queue");
type DbModule = typeof import("@/lib/db");

let queue: QueueModule;
let dbm: DbModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("delivery_queue");

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
 * A report/verdict/outbound_delivery triple, seeded directly rather than through the
 * (nonexistent) approval flow. This module tests outbox mechanics, not how a row gets into
 * the outbox, so bypassing the report-lifecycle graph here is deliberate.
 */
async function seedDelivery(
  overrides: Partial<{ attempts: number; maxAttempts: number }> = {},
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
      state: "DELIVERING",
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

  const [d] = await dbm.db
    .insert(dbm.outboundDelivery)
    .values({
      reportId: r.id,
      verdictId: v.id,
      idempotencyKey: `key-${n}`,
      target: `github:1:issue:${n}`,
      approvedContentHash: `hash-${n}`,
      ...overrides,
    })
    .returning({ id: dbm.outboundDelivery.id });

  return { reportId: r.id, verdictId: v.id, deliveryId: d.id };
}

/**
 * claim() is global, taking the oldest claimable row in the whole table, so a test that
 * seeds its own row is still not guaranteed to be handed it if an earlier test's row is
 * still PENDING. Marking everything SENT makes "the row I just seeded" the only claimable
 * thing left.
 */
async function drainOthers() {
  await dbm.db
    .update(dbm.outboundDelivery)
    .set({ state: "SENT", leaseOwner: null, leaseExpiresAt: null });
}

test("SKIP LOCKED means a second claim does not block on a locked row", async () => {
  await drainOthers();
  await seedDelivery();
  await seedDelivery();

  const holder = await schema.admin.reserve();
  await holder.unsafe(`set search_path to "${schema.name}"`);
  await holder.unsafe("begin");
  const [locked] = await holder.unsafe(
    `select id from outbound_delivery where state = 'PENDING' order by next_attempt_at limit 1 for update`,
  );

  try {
    const claimed = await Promise.race([
      queue.claim("worker-b", 60),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("claim blocked on a locked row")),
          4000,
        ),
      ),
    ]);

    assert.ok(claimed, "a second delivery should have been available");
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

test("releasing an unstarted claim restores its attempt budget", async () => {
  await drainOthers();
  const seeded = await seedDelivery();
  const lease = await queue.claim("worker-deadline", 60);
  assert.ok(lease);

  await queue.releaseUnstarted(lease);

  const [row] = await dbm.db
    .select({
      attempts: dbm.outboundDelivery.attempts,
      leaseOwner: dbm.outboundDelivery.leaseOwner,
    })
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.id, seeded.deliveryId));
  assert.equal(row.attempts, 0);
  assert.equal(row.leaseOwner, null);
});

test("a stale fence cannot mutate a delivery once another worker reclaims it", async () => {
  await drainOthers();
  const seeded = await seedDelivery();

  const stale = await queue.claim("worker-stale", 60);
  assert.ok(stale);
  assert.equal(stale.id, seeded.deliveryId);
  assert.ok(stale.fence > 0, "a claim must issue a fence token");

  // Expire the lease, as if this worker had stalled past it.
  await dbm.db
    .update(dbm.outboundDelivery)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.outboundDelivery.id, stale.id));

  const fresh = await queue.claim("worker-fresh", 60);
  assert.ok(fresh);
  assert.equal(
    fresh.id,
    stale.id,
    "the abandoned row should have been reclaimed",
  );
  assert.ok(fresh.fence > stale.fence, "reclaiming must issue a newer fence");

  // The stale worker comes back and tries to act on a lease it no longer holds.
  await assert.rejects(() => queue.markSent(stale), queue.LeaseLostError);
  await assert.rejects(() => queue.fail(stale, "boom"), queue.LeaseLostError);
  await assert.rejects(
    () => queue.failPermanently(stale, "boom"),
    queue.LeaseLostError,
  );
  await assert.rejects(() => queue.renew(stale, 30), queue.LeaseLostError);

  // The rightful holder is unaffected.
  await queue.markSent(fresh);
});

test("an expired lease is reclaimed by sweepExpiredLeases", async () => {
  await drainOthers();
  const seeded = await seedDelivery();

  const lease = await queue.claim("worker-expiring", 60);
  assert.ok(lease);
  assert.equal(lease.id, seeded.deliveryId);

  await dbm.db
    .update(dbm.outboundDelivery)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.outboundDelivery.id, lease.id));

  const swept = await queue.sweepExpiredLeases();
  assert.ok(
    swept.released >= 1,
    "an expired lease must be cleared for reclaiming",
  );

  const reclaimed = await queue.claim("worker-after-sweep", 60);
  assert.ok(reclaimed);
  assert.equal(reclaimed.id, seeded.deliveryId);
});

test("an expired lease on the final attempt is moved to FAILED", async () => {
  await drainOthers();
  const seeded = await seedDelivery({ maxAttempts: 1 });

  const lease = await queue.claim("worker-final-crash", 60);
  assert.ok(lease);
  assert.equal(lease.attempts, 1);

  await dbm.db
    .update(dbm.outboundDelivery)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.outboundDelivery.id, lease.id));

  const swept = await queue.sweepExpiredLeases();
  assert.equal(swept.failed, 1);

  const [row] = await dbm.db
    .select({
      state: dbm.outboundDelivery.state,
      lastError: dbm.outboundDelivery.lastError,
    })
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.id, seeded.deliveryId));
  assert.equal(row.state, "FAILED");
  assert.match(row.lastError ?? "", /final attempt/);
  assert.equal(await queue.claim("worker-after-final-crash", 60), null);
});

test("fail() backs off and only reaches FAILED once maxAttempts is exhausted", async () => {
  await drainOthers();
  const seeded = await seedDelivery({ maxAttempts: 2 });

  const first = await queue.claim("worker-retry", 60);
  assert.ok(first);
  assert.equal(first.attempts, 1);

  await queue.fail(first, "first attempt: transient");

  const [afterFirst] = await dbm.db
    .select({
      state: dbm.outboundDelivery.state,
      nextAttemptAt: dbm.outboundDelivery.nextAttemptAt,
    })
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.id, seeded.deliveryId));

  assert.equal(
    afterFirst.state,
    "PENDING",
    "attempts remain, so the row stays retryable",
  );
  assert.ok(
    afterFirst.nextAttemptAt.getTime() > Date.now(),
    "backoff must push the next attempt into the future",
  );

  // Force the backoff window open so the second claim does not have to wait on it.
  await dbm.db
    .update(dbm.outboundDelivery)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.outboundDelivery.id, seeded.deliveryId));

  const second = await queue.claim("worker-retry-2", 60);
  assert.ok(second);
  assert.equal(second.attempts, 2, "the claim consumes the final attempt");

  await queue.fail(second, "second attempt: still failing");

  const [afterSecond] = await dbm.db
    .select({
      state: dbm.outboundDelivery.state,
      lastError: dbm.outboundDelivery.lastError,
    })
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.id, seeded.deliveryId));

  assert.equal(afterSecond.state, "FAILED");
  assert.equal(afterSecond.lastError, "second attempt: still failing");
});

test("failPermanently moves straight to FAILED regardless of attempts remaining", async () => {
  await drainOthers();
  const seeded = await seedDelivery({ maxAttempts: 8 });

  const lease = await queue.claim("worker-refused", 60);
  assert.ok(lease);
  assert.equal(lease.attempts, 1, "plenty of attempts are still left");

  await queue.failPermanently(lease, "repository is no longer connected");

  const [row] = await dbm.db
    .select({
      state: dbm.outboundDelivery.state,
      lastError: dbm.outboundDelivery.lastError,
    })
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.id, seeded.deliveryId));

  assert.equal(
    row.state,
    "FAILED",
    "a permanent refusal skips the retry budget entirely",
  );
  assert.equal(row.lastError, "repository is no longer connected");
});
