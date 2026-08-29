import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Imported dynamically, after createSchema has set DATABASE_SCHEMA: queue.ts pulls in @/lib/db,
 * which builds its pool at import time, so a static import would bind the pool to the wrong
 * schema before the harness got a say.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let queue: typeof import("./queue");
let targetProfileId: string;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("reports_queue");

  dbm = await import("@/lib/db");
  queue = await import("./queue");

  const [profile] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: "juice-shop-v17.3.0", imageDigest: `sha256:${"0".repeat(64)}` })
    .returning({ id: dbm.targetProfile.id });

  targetProfileId = profile.id;
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let issues = 0;

async function seedReport(
  state: import("@/lib/reports/states").ReportState,
  opts: { target?: boolean; sourceRef?: string } = {},
): Promise<string> {
  issues += 1;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: opts.sourceRef ?? `github:1:issue:${issues}`,
      title: `report ${issues}`,
      body: "body",
      state,
      targetProfileId: opts.target === false ? null : targetProfileId,
    })
    .returning({ id: dbm.report.id });

  return row.id;
}

function column(columns: import("./queue").QueueColumn[], key: string) {
  const found = columns.find((c) => c.key === key);
  assert.ok(found, `no column ${key}`);
  return found;
}

test("every lifecycle state lands in exactly one column", () => {
  const seen = new Set<string>();
  for (const col of queue.COLUMNS) {
    for (const state of col.states) {
      assert.equal(seen.has(state), false, `${state} is in more than one column`);
      seen.add(state);
    }
  }

  // The frozen enum, from docs/decisions.md. A state missing here is a report nobody can see.
  assert.deepEqual([...seen].sort(), [
    "ANALYSIS_ONLY",
    "AWAITING_APPROVAL",
    "CANCELLED",
    "DELIVERED",
    "DELIVERING",
    "DENIED",
    "EXPIRED",
    "OUT_OF_SCOPE",
    "REPRODUCING",
    "TRIAGING",
  ]);
});

test("sourceLabel prefers the issue number and falls back to a short id", () => {
  assert.equal(queue.sourceLabel("github:123456:issue:482", "abcdef12-0000"), "#482");
  assert.equal(queue.sourceLabel("email:someone@example.com", "abcdef12-0000"), "#abcdef12");
  // A malformed github ref must not be shown as an issue number it does not have.
  assert.equal(queue.sourceLabel("github:1:issue:", "abcdef12-0000"), "#abcdef12");
});

test("an empty database still returns every column, so the board can say so", async () => {
  const columns = await queue.listQueue();

  assert.equal(columns.length, queue.COLUMNS.length);
  for (const col of columns) {
    assert.equal(col.total, 0, `${col.key} should be empty`);
    assert.deepEqual(col.cards, []);
  }
});

test("reports bucket into their column and terminal states collapse into Closed", async () => {
  await seedReport("TRIAGING");
  await seedReport("REPRODUCING");
  await seedReport("ANALYSIS_ONLY");
  await seedReport("DELIVERING");
  await seedReport("DELIVERED");
  await seedReport("DENIED");
  await seedReport("OUT_OF_SCOPE");
  await seedReport("CANCELLED");
  await seedReport("EXPIRED");

  const columns = await queue.listQueue();

  assert.equal(column(columns, "triaging").total, 1);
  assert.equal(column(columns, "reproducing").total, 1);
  assert.equal(column(columns, "analysis-only").total, 1);
  // DELIVERING and DELIVERED share a column: one is the other in flight.
  assert.equal(column(columns, "delivered").total, 2);
  assert.equal(column(columns, "closed").total, 4);
});

test("a report with no target and no verdict reads as exactly that", async () => {
  const id = await seedReport("TRIAGING", { target: false });
  const columns = await queue.listQueue();
  const card = column(columns, "triaging").cards.find((c) => c.id === id);

  assert.ok(card);
  assert.equal(card.targetName, null);
  assert.equal(card.outcome, null);
  assert.equal(card.eventCount, 0);
  assert.equal(card.awaitingVerdictId, null);
});

test("the card carries the latest verdict revision, not the first", async () => {
  const id = await seedReport("ANALYSIS_ONLY");

  for (const [revision, outcome] of [
    [1, "INCONCLUSIVE"],
    [2, "ANALYSIS_ONLY"],
  ] as const) {
    await dbm.db.insert(dbm.verdict).values({
      reportId: id,
      outcome,
      summary: `revision ${revision}`,
      payload: `payload ${revision}`,
      contentHash: `hash-${id}-${revision}`,
      revision,
    });
  }

  const columns = await queue.listQueue();
  const card = column(columns, "analysis-only").cards.find((c) => c.id === id);

  assert.ok(card);
  assert.equal(card.outcome, "ANALYSIS_ONLY");
});

test("eventCount counts session events, and cards sort newest first", async () => {
  const older = await seedReport("REPRODUCING");
  const { recordEvent } = await import("./lifecycle");
  await recordEvent(older, "intake.accepted");
  await recordEvent(older, "analysis.completed");

  // updated_at defaults to now(), so a later insert is genuinely later.
  const newer = await seedReport("REPRODUCING");

  const columns = await queue.listQueue();
  const cards = column(columns, "reproducing").cards;
  const positions = [cards.findIndex((c) => c.id === newer), cards.findIndex((c) => c.id === older)];

  assert.ok(positions[0] < positions[1], "newer report should sort ahead of older");
  assert.equal(cards.find((c) => c.id === older)?.eventCount, 2);
});

test("awaitingVerdictId is set only when there is a call a reviewer can answer", async () => {
  const withoutCall = await seedReport("AWAITING_APPROVAL");
  await dbm.db.insert(dbm.agentSession).values({
    reportId: withoutCall,
    capabilityToken: `token-${withoutCall}`,
    sessionId: `session-${withoutCall}`,
  });

  const id = await seedReport("AWAITING_APPROVAL");
  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: id,
      outcome: "REPRODUCED",
      summary: "reproduced",
      payload: "the exact comment",
      contentHash: `hash-${id}`,
    })
    .returning({ id: dbm.verdict.id });

  // agent_session_pending_all_or_none means the four pending columns cannot be written apart,
  // so the only two shapes that exist are none of them and all of them.
  await dbm.db.insert(dbm.agentSession).values({
    reportId: id,
    capabilityToken: `token-${id}`,
    sessionId: `session-${id}`,
    pendingThreadId: "thread-1",
    pendingToolCallId: "call-1",
    pendingVerdictId: v.id,
    pendingApprovedContentHash: `hash-${id}`,
  });

  const columns = await queue.listQueue();
  const cards = column(columns, "awaiting-approval").cards;

  // A session that has not reached a pending call yet offers no button, because there is
  // nothing to answer.
  assert.equal(cards.find((c) => c.id === withoutCall)?.awaitingVerdictId, null);
  assert.equal(cards.find((c) => c.id === id)?.awaitingVerdictId, v.id);
});

test("a column past the limit caps its cards but still reports the true total", async () => {
  const extra = queue.COLUMN_LIMIT + 5;
  for (let i = 0; i < extra; i += 1) await seedReport("EXPIRED");

  const columns = await queue.listQueue();
  const closed = column(columns, "closed");

  assert.equal(closed.cards.length, queue.COLUMN_LIMIT);
  // Whatever else is closed from earlier tests, the total has to exceed what was rendered,
  // otherwise the screen would silently claim it had shown everything.
  assert.ok(closed.total > closed.cards.length);
});
