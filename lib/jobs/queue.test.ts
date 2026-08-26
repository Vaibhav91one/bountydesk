import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * These run against a real Postgres, because every guarantee asserted here is the database's:
 * SKIP LOCKED, the unique delivery constraint, compare-and-swap on the lease. A mock would
 * agree with a wrong implementation.
 *
 * Each run gets a disposable schema of its own. claim() is deliberately global, taking the
 * oldest claimable job in the table, so sharing a schema would let one run's rows be handed
 * to another's workers, and a crashed run would poison the next one. The schema is created
 * here, the migrations are replayed into it, and it is dropped at the end.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

// Imported dynamically so DATABASE_SCHEMA is set before the pool is constructed.
type QueueModule = typeof import("./queue");
type DbModule = typeof import("@/lib/db");

let queue: QueueModule;
let dbm: DbModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("queue");

  dbm = await import("@/lib/db");
  queue = await import("./queue");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;
async function seed() {
  return queue.enqueue({
    channel: "github",
    deliveryId: `delivery-${seq++}`,
    payload: { n: seq },
  });
}

/**
 * Retire everything currently in the queue.
 *
 * claim() is deliberately global, taking the oldest claimable job rather than one belonging
 * to the caller, so a test that seeds a job and immediately claims would otherwise be handed
 * whatever an earlier test left behind. Draining first makes "the job I just seeded" the only
 * thing claimable, which is what these assertions mean to talk about.
 */
async function drain() {
  await dbm.db
    .update(dbm.inboundJob)
    .set({ state: "DONE", leaseOwner: null, leaseExpiresAt: null });
}

test("a replayed delivery does not create a second job", async () => {
  const first = await queue.enqueue({
    channel: "github",
    deliveryId: "replayed",
    payload: { attempt: 1 },
  });
  const second = await queue.enqueue({
    channel: "github",
    deliveryId: "replayed",
    payload: { attempt: 2 },
  });

  assert.equal(first.disposition, "CREATED");
  assert.equal(
    second.disposition,
    "IN_FLIGHT",
    "a non-terminal replay must not be classified as completed work",
  );
  assert.equal(second.jobId, first.jobId, "a replay must resolve to the same job");

  const claimed = await queue.claim("worker-replay", 60);
  assert.ok(claimed);
  const running = await queue.advance(
    await queue.advance(await queue.advance(claimed, "PARSED"), "SESSION_CREATED"),
    "RUNNING",
  );
  await queue.complete(running);

  const terminalReplay = await queue.enqueue({
    channel: "github",
    deliveryId: "replayed",
    payload: { attempt: 3 },
  });
  assert.equal(terminalReplay.disposition, "TERMINAL_REPLAY");
});

test("SKIP LOCKED means a second claim does not block on a locked row", async () => {
  await seed();
  await seed();

  // Hold the first claimable row locked inside an open transaction, and keep it open.
  const holder = await schema.admin.reserve();
  await holder.unsafe(`set search_path to "${schema.name}"`);
  await holder.unsafe("begin");
  const [locked] = await holder.unsafe(
    `select id from inbound_job
      where state not in ('DONE','DEAD_LETTER')
      order by next_attempt_at limit 1 for update`,
  );

  try {
    // With SKIP LOCKED this returns the *other* row immediately. Without it, this would wait
    // on the held lock and the timeout below would fire.
    const claimed = await Promise.race([
      queue.claim("worker-b", 60),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("claim blocked on a locked row")), 4000),
      ),
    ]);

    assert.ok(claimed, "a second job should have been available");
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

test("claiming takes ownership without moving the job through the lifecycle", async () => {
  await drain();
  const job = await seed();
  const lease = await queue.claim("worker-lifecycle", 60);

  assert.ok(lease);
  assert.equal(
    lease.state,
    "RECEIVED",
    "claiming must not stamp RUNNING and skip PARSED/SESSION_CREATED",
  );
  assert.equal(lease.attempts, 1);
  assert.ok(lease.fence > 0, "a claim must issue a fence token");

  const parsed = await queue.advance(lease, "PARSED", { reportId: undefined });
  assert.equal(parsed.state, "PARSED");

  await queue.complete(await queue.advance(await queue.advance(parsed, "SESSION_CREATED"), "RUNNING"));

  const [row] = await dbm.db
    .select({ state: dbm.inboundJob.state, leaseOwner: dbm.inboundJob.leaseOwner })
    .from(dbm.inboundJob)
    .where(dbm.eq(dbm.inboundJob.id, job.jobId));

  assert.equal(row.state, "DONE");
  assert.equal(row.leaseOwner, null, "completing must release the lease");
});

test("an illegal transition is refused", async () => {
  await drain();
  await seed();
  const lease = await queue.claim("worker-illegal", 60);
  assert.ok(lease);

  await assert.rejects(
    () => queue.advance(lease, "DONE"),
    /illegal job transition RECEIVED -> DONE/,
    "the state graph must not allow skipping straight to DONE",
  );

  // Terminal states are one-way.
  const done = await queue.advance(
    await queue.advance(await queue.advance(lease, "PARSED"), "SESSION_CREATED"),
    "RUNNING",
  );
  await queue.complete(done);
  assert.equal(queue.canTransition("DONE", "PARSED"), false);
  assert.equal(queue.canTransition("DEAD_LETTER", "RECEIVED"), false);
});

test("a job cannot be completed before it reaches RUNNING", async () => {
  await drain();
  await seed();

  const received = await queue.claim("worker-too-early", 60);
  assert.ok(received);

  await assert.rejects(
    () => queue.complete(received),
    /illegal job transition RECEIVED -> DONE/,
  );
});

test("a worker that lost its lease cannot write over the one that took over", async () => {
  await drain();
  await seed();

  const claimed = await queue.claim("worker-stale", 60);
  assert.ok(claimed);
  const stale = await queue.advance(
    await queue.advance(await queue.advance(claimed, "PARSED"), "SESSION_CREATED"),
    "RUNNING",
  );

  // Expire the lease, as if this worker had stalled past it.
  await dbm.db
    .update(dbm.inboundJob)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.inboundJob.id, stale.id));

  const fresh = await queue.claim("worker-fresh", 60);
  assert.ok(fresh);
  assert.equal(fresh.id, stale.id, "the abandoned job should have been reclaimed");
  assert.ok(fresh.fence > stale.fence, "reclaiming must issue a newer fence");

  // The stale worker now comes back to life and tries to finish the job it thinks it owns.
  await assert.rejects(() => queue.advance(stale, "DONE"), queue.LeaseLostError);
  await assert.rejects(() => queue.complete(stale), queue.LeaseLostError);
  await assert.rejects(() => queue.fail(stale, "boom"), queue.LeaseLostError);

  // The rightful holder is unaffected.
  await queue.complete(fresh);
});

test("an expired lease cannot mutate a job before another worker reclaims it", async () => {
  await drain();
  await seed();

  const claimed = await queue.claim("worker-expired", 60);
  assert.ok(claimed);
  const expired = await queue.advance(
    await queue.advance(await queue.advance(claimed, "PARSED"), "SESSION_CREATED"),
    "RUNNING",
  );

  await dbm.db
    .update(dbm.inboundJob)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.inboundJob.id, expired.id));

  await assert.rejects(() => queue.advance(expired, "DONE"), queue.LeaseLostError);
  await assert.rejects(() => queue.complete(expired), queue.LeaseLostError);
  await assert.rejects(() => queue.fail(expired, "too late"), queue.LeaseLostError);
});

test("a job is buried once it exhausts its attempts", async () => {
  await drain();
  const job = await seed();

  await dbm.db
    .update(dbm.inboundJob)
    .set({ attempts: 4, maxAttempts: 5 })
    .where(dbm.eq(dbm.inboundJob.id, job.jobId));

  const lease = await queue.claim("worker-doomed", 60);
  assert.ok(lease);
  assert.equal(lease.attempts, 5, "the claim should consume the final attempt");

  await queue.fail(lease, "exploded");

  const [row] = await dbm.db
    .select({ state: dbm.inboundJob.state, lastError: dbm.inboundJob.lastError })
    .from(dbm.inboundJob)
    .where(dbm.eq(dbm.inboundJob.id, job.jobId));

  assert.equal(row.state, "DEAD_LETTER");
  assert.equal(row.lastError, "exploded");
});

test("a worker that dies on its final attempt is dead-lettered, not retried forever", async () => {
  await drain();
  const job = await seed();

  await dbm.db
    .update(dbm.inboundJob)
    .set({ attempts: 4, maxAttempts: 5 })
    .where(dbm.eq(dbm.inboundJob.id, job.jobId));

  const lease = await queue.claim("worker-crashes", 60);
  assert.ok(lease);

  // The worker dies: no fail(), no complete(), just an abandoned lease.
  await dbm.db
    .update(dbm.inboundJob)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.inboundJob.id, job.jobId));

  const swept = await queue.sweepExpiredLeases();
  assert.ok(swept.deadLettered >= 1, "an exhausted, abandoned job must be buried");

  const [row] = await dbm.db
    .select({ state: dbm.inboundJob.state })
    .from(dbm.inboundJob)
    .where(dbm.eq(dbm.inboundJob.id, job.jobId));

  assert.equal(
    row.state,
    "DEAD_LETTER",
    "otherwise it sits non-terminal forever, invisible to the queue and the dead-letter view",
  );
});
