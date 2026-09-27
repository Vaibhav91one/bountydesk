import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Imported dynamically, after createSchema has set DATABASE_SCHEMA: lifecycle.ts pulls in @/lib/db,
 * which builds its pool at import time, so a static import would bind the pool to the wrong schema.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let lifecycle: typeof import("./lifecycle");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("reports_lifecycle");
  dbm = await import("@/lib/db");
  lifecycle = await import("./lifecycle");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

/** Seed an email report that arrived from a verified outside sender. Returns its id. */
async function seedParent(sender: string): Promise<{ id: string; messageId: string }> {
  seq += 1;
  const messageId = `<parent-${seq}@mail.test>`;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "email",
      sourceRef: `email:${messageId}`,
      title: `report ${seq}`,
      body: "the reporter's own words",
      reporterContact: sender,
      verifiedSender: sender,
      state: "NEEDS_DECISION",
      connectedRepositoryId: null,
      targetProfileId: null,
    })
    .returning({ id: dbm.report.id });
  return { id: row.id, messageId };
}

test("a reply threaded to a parent with the same verified sender links to it", async () => {
  const sender = "ada@example.com";
  const parent = await seedParent(sender);
  const linked = await lifecycle.findRepliedToReport(
    ["<unknown@mail.test>", parent.messageId],
    sender,
  );
  assert.equal(linked, parent.id);
});

test("a reply from a different verified sender does not link", async () => {
  const parent = await seedParent("ada@example.com");
  const linked = await lifecycle.findRepliedToReport([parent.messageId], "mallory@example.com");
  assert.equal(linked, null);
});

test("a reply with no matching token does not link", async () => {
  const sender = "grace@example.com";
  await seedParent(sender);
  const linked = await lifecycle.findRepliedToReport(["<nothing-matches@mail.test>"], sender);
  assert.equal(linked, null);
});

test("no tokens and no verified sender both short-circuit to null", async () => {
  const parent = await seedParent("hopper@example.com");
  assert.equal(await lifecycle.findRepliedToReport([], "hopper@example.com"), null);
  assert.equal(await lifecycle.findRepliedToReport([parent.messageId], null), null);
});

/**
 * Concurrent writers for one report must not collide on (report_id, seq). recordEvent allocates
 * seq as max(seq) + 1 and leans on the unique index to reject a collision, then retries with a
 * fresh max. This fires the poller-style and gate-style paths at once, hard enough to force those
 * retries, and asserts every write still lands on a distinct, contiguous seq with nothing thrown.
 */
test("concurrent event writers get distinct contiguous seqs with no unique violation", async () => {
  const parent = await seedParent("concurrent@example.com");
  const writers = 40;

  await Promise.all(
    Array.from({ length: writers }, (_, i) =>
      // Alternate the poller-style path and the gate-style helper against one report.
      i % 2 === 0
        ? lifecycle.recordEvent(parent.id, `poller.event.${i}`)
        : lifecycle.recordEventLocked(parent.id, `gate.event.${i}`),
    ),
  );

  const rows = await dbm.db
    .select({ seq: dbm.sessionEvent.seq })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, parent.id))
    .orderBy(dbm.sessionEvent.seq);

  const seqs = rows.map((r) => r.seq);
  assert.equal(seqs.length, writers);
  assert.deepEqual(seqs, Array.from({ length: writers }, (_, i) => i + 1));
});

/**
 * The same must hold when the writers each pass their own transaction, the way in-worker callers
 * do. Here the retry runs as a savepoint inside the caller's transaction: a rejected insert rolls
 * back to the savepoint without poisoning the transaction, so the retry can commit the next seq.
 */
test("concurrent writers on their own transactions retry cleanly and stay contiguous", async () => {
  const parent = await seedParent("tx-concurrent@example.com");
  const writers = 20;

  await Promise.all(
    Array.from({ length: writers }, (_, i) =>
      dbm.db.transaction((tx) => lifecycle.recordEvent(parent.id, `tx.event.${i}`, {}, { tx })),
    ),
  );

  const rows = await dbm.db
    .select({ seq: dbm.sessionEvent.seq })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, parent.id))
    .orderBy(dbm.sessionEvent.seq);

  assert.deepEqual(rows.map((r) => r.seq), Array.from({ length: writers }, (_, i) => i + 1));
});

/**
 * The idempotency key still dedupes under contention: the same key fired concurrently inserts
 * exactly once and never trips the seq index while doing so.
 */
test("a repeated idempotency key inserts once under concurrent writers", async () => {
  const parent = await seedParent("idempotent@example.com");

  await Promise.all(
    Array.from({ length: 20 }, () =>
      lifecycle.recordEvent(parent.id, "agent.tool_call", {}, { idempotencyKey: "same-key" }),
    ),
  );

  const rows = await dbm.db
    .select({ seq: dbm.sessionEvent.seq })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, parent.id));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].seq, 1);
});
