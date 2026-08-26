import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { and, eq, inArray, like, lt } from "drizzle-orm";

import { client, db, inboundJob } from "@/lib/db";
import { claim, complete, enqueue, fail, sweepExpiredLeases } from "./queue";

// Each run tags its own rows so a failed run can never poison the next one, and so this is
// safe to run against a database that has other data in it.
const RUN = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const created: string[] = [];

async function seed(suffix: string) {
  const result = await enqueue({
    channel: "github",
    deliveryId: `${RUN}-${suffix}`,
    payload: { hello: suffix },
  });
  created.push(result.jobId);
  return result;
}

before(async () => {
  await db.execute("select 1");
  // claim() deliberately takes the oldest claimable job in the table, so a row left behind by
  // a crashed earlier run would be handed to these tests instead of their own. Clear those,
  // but only ones old enough that they cannot belong to a test run happening right now.
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  await db
    .delete(inboundJob)
    .where(and(like(inboundJob.deliveryId, "test-%"), lt(inboundJob.createdAt, cutoff)));
});

after(async () => {
  if (created.length > 0) {
    await db.delete(inboundJob).where(inArray(inboundJob.id, created));
  }
  await client.end({ timeout: 5 });
});

test("a replayed delivery does not create a second job", async () => {
  const first = await seed("replay");
  const second = await enqueue({
    channel: "github",
    deliveryId: `${RUN}-replay`,
    payload: { hello: "replay-again" },
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false, "replay must not create a new job");
  assert.equal(second.jobId, first.jobId, "replay must resolve to the same job");

  // Retire it so it cannot be the job a later test's claim() picks up: claim() is
  // deliberately global-FIFO, so anything left claimable is fair game for the next caller.
  await complete(first.jobId);
});

test("two concurrent workers never claim the same job", async () => {
  await seed("race-a");
  await seed("race-b");

  // Fire both claims at once. Without SKIP LOCKED one would block on the other's row lock;
  // with it, each takes a different row.
  const [a, b] = await Promise.all([claim("worker-a", 60), claim("worker-b", 60)]);

  assert.ok(a, "worker-a should have claimed a job");
  assert.ok(b, "worker-b should have claimed a job");
  assert.notEqual(a.id, b.id, "the same job was handed to both workers");

  await complete(a.id);
  await complete(b.id);
});

test("a completed job is not claimable again", async () => {
  const job = await seed("once");
  const claimed = await claim("worker-once", 60);
  assert.ok(claimed);
  await complete(claimed.id);

  const [row] = await db
    .select({ state: inboundJob.state, leaseOwner: inboundJob.leaseOwner })
    .from(inboundJob)
    .where(eq(inboundJob.id, job.jobId));

  assert.equal(row.state, "DONE");
  assert.equal(row.leaseOwner, null, "completing must release the lease");
});

test("an expired lease is reclaimable, which is how a crashed worker recovers", async () => {
  const job = await seed("crash");

  const claimed = await claim("worker-doomed", 60);
  assert.ok(claimed);

  // Simulate the worker dying: the lease stays behind, pointing at nobody who is still alive.
  await db
    .update(inboundJob)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(inboundJob.id, claimed.id));

  const swept = await sweepExpiredLeases();
  assert.ok(swept >= 1, "sweeper should have released at least the dead lease");

  const reclaimed = await claim("worker-healthy", 60);
  assert.ok(reclaimed, "an abandoned job must become claimable again");

  await complete(reclaimed.id);
  await complete(job.jobId);
});

test("a job is buried once it exhausts its attempts", async () => {
  const job = await seed("bury");

  await db
    .update(inboundJob)
    .set({ attempts: 5, maxAttempts: 5 })
    .where(eq(inboundJob.id, job.jobId));

  await fail(job.jobId, "exploded");

  const [row] = await db
    .select({ state: inboundJob.state, lastError: inboundJob.lastError })
    .from(inboundJob)
    .where(eq(inboundJob.id, job.jobId));

  assert.equal(row.state, "DEAD_LETTER");
  assert.equal(row.lastError, "exploded");
});
