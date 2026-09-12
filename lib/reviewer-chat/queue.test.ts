import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { computeContentHash } from "@/lib/verdicts/hash";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let queue: typeof import("./queue");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("reviewer_chat_queue");
  dbm = await import("@/lib/db");
  queue = await import("./queue");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let sequence = 0;
async function seedReport(verdictRow = true) {
  sequence += 1;
  const n = sequence;
  const [r] = await dbm.db.insert(dbm.report).values({
    channel: "github",
    sourceRef: `github:1:issue:chat-${n}`,
    title: "chat report",
    body: "Please review this report",
    state: verdictRow ? "AWAITING_APPROVAL" : "TRIAGING",
  }).returning({ id: dbm.report.id });
  let verdictId: string | undefined;
  if (verdictRow) {
    const [v] = await dbm.db.insert(dbm.verdict).values({
      reportId: r.id,
      outcome: "NOT_REPRODUCED",
      summary: "summary",
      payload: `payload-${n}`,
      contentHash: computeContentHash(`payload-${n}`),
    }).returning({ id: dbm.verdict.id });
    verdictId = v.id;
  }
  return { reportId: r.id, verdictId };
}

async function drainThreads() {
  await dbm.db.update(dbm.reviewerChatThread).set({
    status: "CANCELLED",
    leaseOwner: null,
    leaseExpiresAt: null,
  });
}

test("duplicate clientRequestId returns the original message and does not enqueue twice", async () => {
  await drainThreads();
  const { reportId } = await seedReport();
  const first = await queue.enqueueMessage({ reportId, reviewerId: "42", clientRequestId: "req-1", body: "Check auth" });
  const second = await queue.enqueueMessage({ reportId, reviewerId: "42", clientRequestId: "req-1", body: "A different retry body" });
  assert.equal(second.disposition, "DUPLICATE");
  assert.equal(second.messageId, first.messageId);
  const messages = await dbm.db.select().from(dbm.reviewerChatMessage).where(dbm.eq(dbm.reviewerChatMessage.threadId, first.threadId));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "Check auth");
});

test("claim, expired lease reclaim, and stale fence are enforced", async () => {
  await drainThreads();
  const { reportId } = await seedReport();
  const queued = await queue.enqueueMessage({ reportId, reviewerId: "42", clientRequestId: "req-lease", body: "Question" });
  const stale = await queue.claim("worker-stale", 60);
  assert.ok(stale);
  assert.equal(stale.threadId, queued.threadId);
  await dbm.db.update(dbm.reviewerChatThread).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(dbm.eq(dbm.reviewerChatThread.id, stale.threadId));
  const fresh = await queue.claim("worker-fresh", 60);
  assert.ok(fresh);
  assert.ok(fresh.fence > stale.fence);
  await assert.rejects(() => queue.renew(stale, 30), queue.LeaseLostError);
  await queue.releaseUnstarted(fresh);
  const swept = await queue.sweepExpiredLeases();
  assert.ok(swept.released >= 0);
});

test("complete binds agent response to the fenced reviewer message and leaves it append-only", async () => {
  await drainThreads();
  const { reportId } = await seedReport();
  const queued = await queue.enqueueMessage({ reportId, reviewerId: "42", clientRequestId: "req-done", body: "Question" });
  const lease = await queue.claim("worker-done", 60);
  assert.ok(lease);
  await queue.complete(lease, { body: "Plain answer", providerTurnId: "turn-1" });
  const status = await queue.readChatStatus(reportId);
  assert.ok(status);
  assert.equal(status.threads[0].messages.length, 2);
  assert.equal(status.threads[0].messages[1].sender, "AGENT");
  assert.equal(status.threads[0].messages[1].bodyHash, queue.computeMessageHash("Plain answer"));
  await assert.rejects(() => dbm.db.update(dbm.reviewerChatMessage).set({ body: "tampered" }).where(dbm.eq(dbm.reviewerChatMessage.id, queued.messageId)));
});

test("enqueue refuses a verdict whose stored content hash does not match its payload before a worker call", async () => {
  await drainThreads();
  const { reportId } = await seedReport();
  // Verdicts are immutable. Seed the mismatch through the disposable schema's privileged SQL
  // connection, which models a corrupt legacy row without weakening the production trigger.
  await schema.admin.unsafe(`alter table "${schema.name}".verdict disable trigger verdict_is_immutable`);
  await dbm.db.update(dbm.verdict).set({ contentHash: "wrong" }).where(dbm.eq(dbm.verdict.reportId, reportId));
  await schema.admin.unsafe(`alter table "${schema.name}".verdict enable trigger verdict_is_immutable`);
  await assert.rejects(() => queue.enqueueMessage({ reportId, reviewerId: "42", clientRequestId: "req-hash", body: "Question" }), /content hash/);
});
