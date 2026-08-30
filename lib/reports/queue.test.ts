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

test("reports bucket into the column their state belongs to", async () => {
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

test("a delivered report is terminal, and still does not sit in Closed", async () => {
  // The board's grouping is not the lifecycle's. TERMINAL_STATES is the authority on which
  // states are terminal; Closed is a column, and it holds the four terminal states that mean
  // no verdict shipped. Splitting them is the point, so it gets asserted rather than assumed.
  const { TERMINAL_STATES } = await import("./states");
  assert.ok(TERMINAL_STATES.includes("DELIVERED"));

  assert.equal(queue.phaseOf("DELIVERED"), "delivered");
  assert.equal(
    queue.COLUMNS.find((c) => c.key === "closed")?.states.includes("DELIVERED"),
    false,
  );

  // Every terminal state still appears somewhere: four in Closed, DELIVERED in its own column.
  for (const state of TERMINAL_STATES) {
    assert.ok(queue.COLUMNS.some((c) => c.states.includes(state)), `${state} has no column`);
  }
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

test("a card badges an agent that is actively investigating, and stops once a verdict lands", async () => {
  const { recordEvent } = await import("./lifecycle");

  const investigating = await seedReport("TRIAGING");
  await dbm.db.insert(dbm.agentSession).values({
    reportId: investigating,
    capabilityToken: `token-${investigating}`,
    sessionId: `session-${investigating}`,
    turnStatus: "INVESTIGATING",
  });
  await recordEvent(investigating, "agent.tool_call:scope_check");

  // A turn exists and is RUNNING, but the poller has not mirrored a single tool call yet: this
  // is the instant right after createTurn, and must not read as "investigating" just because
  // the turn status says so.
  const justStarted = await seedReport("TRIAGING");
  await dbm.db.insert(dbm.agentSession).values({
    reportId: justStarted,
    capabilityToken: `token-${justStarted}`,
    sessionId: `session-${justStarted}`,
    turnStatus: "RUNNING",
  });

  // Same turn status and tool-call activity as `investigating`, but a verdict already exists:
  // the badge must not still claim the agent is working this report.
  const verdicted = await seedReport("ANALYSIS_ONLY");
  await dbm.db.insert(dbm.verdict).values({
    reportId: verdicted,
    outcome: "ANALYSIS_ONLY",
    summary: "drafted",
    payload: "the exact comment",
    contentHash: `hash-${verdicted}`,
  });
  await dbm.db.insert(dbm.agentSession).values({
    reportId: verdicted,
    capabilityToken: `token-${verdicted}`,
    sessionId: `session-${verdicted}`,
    turnStatus: "INVESTIGATING",
  });
  await recordEvent(verdicted, "agent.tool_call:scope_check");

  const columns = await queue.listQueue();
  const cards = columns.flatMap((c) => c.cards);
  assert.equal(cards.find((c) => c.id === investigating)?.investigating, true);
  assert.equal(cards.find((c) => c.id === justStarted)?.investigating, false);
  assert.equal(cards.find((c) => c.id === verdicted)?.investigating, false);
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

test("phaseOf agrees with COLUMNS for every state", () => {
  for (const col of queue.COLUMNS) {
    for (const state of col.states) {
      assert.equal(queue.phaseOf(state), col.key, `${state} should be in ${col.key}`);
    }
  }
});

test("listActiveReports puts awaiting approval first and excludes terminal states", async () => {
  // Seeded after the terminal reports above, so recency alone would sort these to the front.
  // Awaiting approval has to beat them on urgency, not on order of insertion.
  await seedReport("TRIAGING");
  await seedReport("REPRODUCING");
  const awaiting = await seedReport("AWAITING_APPROVAL");

  const active = await queue.listActiveReports(5);

  assert.equal(active.length, 5);
  assert.equal(active[0].id, awaiting, "awaiting approval should lead");
  assert.equal(active[0].phase, "awaiting-approval");

  const terminal = new Set(["DELIVERED", "DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"]);
  for (const row of active) {
    assert.equal(terminal.has(row.state), false, `${row.state} is terminal and should be hidden`);
  }
});

test("listActiveReports honours its limit", async () => {
  assert.equal((await queue.listActiveReports(2)).length, 2);
});

test("the board is one moment: cards never outnumber the total they sit under", async () => {
  // The seven reads used to come from seven snapshots, so an intake landing between the count
  // and the cards could render cards above a total of zero. Inserting hard while listQueue
  // runs is what makes that race actually happen; the invariant is what catches it.
  const churn = (async () => {
    for (let i = 0; i < 40; i += 1) await seedReport("TRIAGING");
  })();

  for (let round = 0; round < 6; round += 1) {
    const columns = await queue.listQueue();
    for (const col of columns) {
      assert.ok(
        col.cards.length <= col.total,
        `${col.key}: ${col.cards.length} cards under a total of ${col.total}`,
      );
      if (col.total === 0) assert.deepEqual(col.cards, [], `${col.key} has cards but no total`);
    }
  }

  await churn;
});

test("the index shows terminal reports, which is the whole reason it exists", async () => {
  const delivered = await seedReport("DELIVERED");
  const denied = await seedReport("DENIED");

  const rows = await queue.listAllReports();
  const ids = rows.map((row) => row.id);
  assert.ok(ids.includes(delivered), "a delivered report is missing from the index");
  assert.ok(ids.includes(denied), "a denied report is missing from the index");

  // The board is the opposite: it stops at the non-terminal states on purpose.
  const board = await queue.listQueue();
  const boardIds = board.flatMap((col) => col.cards.map((card) => card.id));
  assert.ok(boardIds.includes(delivered), "the closed column still carries delivered");
});

test("the index flags a report only when a reviewer can actually answer it", async () => {
  // Awaiting approval on paper, with no pending call behind it. A "needs you" badge here
  // would send somebody to a screen whose buttons refuse.
  const stranded = await seedReport("AWAITING_APPROVAL");

  const answerable = await seedReport("AWAITING_APPROVAL");
  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: answerable,
      outcome: "ANALYSIS_ONLY",
      summary: "did not run",
      payload: "the exact comment",
      contentHash: `hash-${answerable}`,
    })
    .returning({ id: dbm.verdict.id });

  await dbm.db.insert(dbm.agentSession).values({
    reportId: answerable,
    capabilityToken: `token-${answerable}`,
    sessionId: `session-${answerable}`,
    pendingThreadId: "thread-1",
    pendingToolCallId: "call-1",
    pendingVerdictId: v.id,
    pendingApprovedContentHash: `hash-${answerable}`,
  });

  const rows = await queue.listAllReports();
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get(stranded)?.awaitingVerdictId, null);
  assert.equal(byId.get(answerable)?.awaitingVerdictId, v.id);
});

test("the index carries the latest verdict revision, not the first", async () => {
  const id = await seedReport("DELIVERED");
  for (const [revision, outcome] of [
    [1, "INCONCLUSIVE"],
    [2, "REPRODUCED"],
  ] as const) {
    await dbm.db.insert(dbm.verdict).values({
      reportId: id,
      outcome,
      summary: `revision ${revision}`,
      payload: `payload ${revision}`,
      contentHash: `index-hash-${id}-${revision}`,
      revision,
    });
  }

  const row = (await queue.listAllReports()).find((r) => r.id === id);
  assert.equal(row?.outcome, "REPRODUCED");
});

test("the home counts split open from closed and only count answerable approvals", async () => {
  const { readHomeSummary } = await import("@/lib/home/summary");

  const before = await readHomeSummary();

  await seedReport("TRIAGING");
  await seedReport("DELIVERED");
  // AWAITING_APPROVAL on paper, with no pending call behind it. A home card saying somebody
  // is waiting on a reviewer would send them to a screen whose buttons refuse.
  await seedReport("AWAITING_APPROVAL");

  const answerable = await seedReport("AWAITING_APPROVAL");
  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: answerable,
      outcome: "ANALYSIS_ONLY",
      summary: "did not run",
      payload: "the exact comment",
      contentHash: `home-hash-${answerable}`,
    })
    .returning({ id: dbm.verdict.id });

  await dbm.db.insert(dbm.agentSession).values({
    reportId: answerable,
    capabilityToken: `home-token-${answerable}`,
    sessionId: `home-session-${answerable}`,
    pendingThreadId: "thread-1",
    pendingToolCallId: "call-1",
    pendingVerdictId: v.id,
    pendingApprovedContentHash: `home-hash-${answerable}`,
  });

  const after = await readHomeSummary();
  assert.equal(after.reports - before.reports, 4);
  // Three of the four are non-terminal; DELIVERED is not.
  assert.equal(after.open - before.open, 3);
  assert.equal(after.awaiting - before.awaiting, 1, "only the one with a pending call counts");
});
