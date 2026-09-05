import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Real Postgres, same reasoning as lib/approval-submission/queue.test.ts: SKIP LOCKED, the
 * fenced compare-and-swap and the backoff formula are guarantees the database provides.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

type QueueModule = typeof import("./queue");
type DbModule = typeof import("@/lib/db");

let queue: QueueModule;
let dbm: DbModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("target_onboarding_queue");
  dbm = await import("@/lib/db");
  queue = await import("./queue");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function seed(state = "PENDING_BUILD") {
  seq += 1;
  const [row] = await dbm.db
    .insert(dbm.targetOnboarding)
    .values({
      repoId: 900_000 + seq,
      repoFullName: `acme/repo-${seq}`,
      sourceRef: `https://github.com/acme/repo-${seq}.git`,
      state,
    })
    .returning({ id: dbm.targetOnboarding.id, repoId: dbm.targetOnboarding.repoId });
  return row;
}

/** claim() is global-FIFO, so park every existing claimable row terminal before a test that
 *  asserts on which row is claimed (see lib/reports/queue.test.ts for the same pattern). */
async function drainAll() {
  await dbm.db
    .update(dbm.targetOnboarding)
    .set({ state: "CONFIGURED", leaseOwner: null, leaseExpiresAt: null });
}

test("enqueue is idempotent on repo id", async () => {
  const repoId = 800_100;
  await queue.enqueue({ repoId, repoFullName: "acme/dup", sourceRef: "https://x/dup.git" });
  await queue.enqueue({ repoId, repoFullName: "acme/dup", sourceRef: "https://x/dup.git" });

  const rows = await dbm.db
    .select({ id: dbm.targetOnboarding.id })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));
  assert.equal(rows.length, 1);
});

test("claim takes a build row and skips the human-gated and terminal states", async () => {
  await drainAll();
  const build = await seed("PENDING_BUILD");
  await seed("AWAITING_APPROVAL");
  await seed("CONFIGURED");

  const seen = new Set<number>();
  for (let i = 0; i < 4; i++) {
    const lease = await queue.claim(`w-${i}`, 60);
    if (!lease) break;
    seen.add(lease.repoId);
    // Park it so the next claim moves on rather than re-taking the same row.
    await queue.advance(lease, "CONFIGURED");
  }
  // Only the PENDING_BUILD row was ever claimable.
  assert.equal(seen.has(build.repoId), true);
  assert.equal(seen.size, 1);
});

test("advance moves state, writes step output, and rejects a lost lease", async () => {
  await drainAll();
  const row = await seed("PENDING_BUILD");
  const lease = await queue.claim("w-advance", 60);
  assert.ok(lease);

  await queue.advance(lease!, "PENDING_MANIFEST", {
    imageName: "ghcr.io/acme/repo",
    imageDigest: `sha256:${"a".repeat(64)}`,
    snapshotId: "snap-1",
    buildMarker: "c".repeat(40),
    dockerfileText: "FROM node:20",
  });

  const [after] = await dbm.db
    .select({ state: dbm.targetOnboarding.state, imageName: dbm.targetOnboarding.imageName })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.id, row.id));
  assert.equal(after.state, "PENDING_MANIFEST");
  assert.equal(after.imageName, "ghcr.io/acme/repo");

  // The lease is spent; a second advance on it must not write.
  await assert.rejects(
    queue.advance(lease!, "AWAITING_APPROVAL"),
    (e: unknown) => e instanceof queue.LeaseLostError,
  );
});

test("fail keeps the row in its current state until attempts are exhausted", async () => {
  await drainAll();
  const row = await seed("PENDING_BUILD");
  const lease = await queue.claim("w-fail", 60);
  assert.ok(lease);
  await queue.fail(lease!, "build blew up");

  const [after] = await dbm.db
    .select({ state: dbm.targetOnboarding.state, lastError: dbm.targetOnboarding.lastError })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.id, row.id));
  // One attempt of eight: still on PENDING_BUILD for retry, error recorded.
  assert.equal(after.state, "PENDING_BUILD");
  assert.match(after.lastError ?? "", /build blew up/);
});

test("sweepExpiredLeases releases a row whose worker died mid-claim", async () => {
  await drainAll();
  const row = await seed("PENDING_BUILD");
  const lease = await queue.claim("w-dead", 60);
  assert.ok(lease);
  // Simulate a dead worker: expire the lease without releasing it.
  await dbm.db
    .update(dbm.targetOnboarding)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.targetOnboarding.id, row.id));

  const { released } = await queue.sweepExpiredLeases();
  assert.ok(released >= 1);

  const reclaimed = await queue.claim("w-after-sweep", 60);
  assert.ok(reclaimed);
});

test("enqueue requeues a FAILED row but leaves an in-progress one alone", async () => {
  const repoId = 800_200;
  await queue.enqueue({ repoId, repoFullName: "acme/r", sourceRef: "https://x/r.git" });

  // A FAILED row is reset to PENDING_BUILD with the corrected source.
  await dbm.db
    .update(dbm.targetOnboarding)
    .set({ state: "FAILED", imageDigest: `sha256:${"a".repeat(64)}`, lastError: "boom" })
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));
  await queue.enqueue({ repoId, repoFullName: "acme/r", sourceRef: "https://x/r-fixed.git" });

  const [row] = await dbm.db
    .select({ state: dbm.targetOnboarding.state, sourceRef: dbm.targetOnboarding.sourceRef, imageDigest: dbm.targetOnboarding.imageDigest, lastError: dbm.targetOnboarding.lastError })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));
  assert.equal(row.state, "PENDING_BUILD");
  assert.equal(row.sourceRef, "https://x/r-fixed.git");
  assert.equal(row.imageDigest, null);
  assert.equal(row.lastError, null);

  // A row mid-flight is not disturbed by a duplicate enqueue.
  await dbm.db
    .update(dbm.targetOnboarding)
    .set({ state: "AWAITING_APPROVAL" })
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));
  await queue.enqueue({ repoId, repoFullName: "acme/r", sourceRef: "https://x/should-be-ignored.git" });
  const [inFlight] = await dbm.db
    .select({ state: dbm.targetOnboarding.state, sourceRef: dbm.targetOnboarding.sourceRef })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));
  assert.equal(inFlight.state, "AWAITING_APPROVAL");
  assert.equal(inFlight.sourceRef, "https://x/r-fixed.git");
});
