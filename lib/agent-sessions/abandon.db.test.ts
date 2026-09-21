import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * abandonVerdictConflict runs against a real Postgres, because it locks the
 * session row, moves the report through the lifecycle graph and writes the
 * audit event in one transaction. A mock would agree with a partial write.
 *
 * Each run gets a disposable schema of its own. The schema is created here,
 * the committed migrations are replayed into it, and it is dropped at the end.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

// Imported dynamically so DATABASE_SCHEMA is set before the pool is constructed.
type DbModule = typeof import("@/lib/db");
type QueueModule = typeof import("./queue");

let dbm: DbModule;
let queue: QueueModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("abandon");

  dbm = await import("@/lib/db");
  queue = await import("./queue");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

type ReportState = (typeof dbm.report.state.enumValues)[number];

/**
 * claim() takes the oldest claimable session in the table, so retire every
 * other row first. Otherwise a test could be handed a session seeded by an
 * earlier test instead of the one it just created.
 */
async function drainSessions() {
  await dbm.db
    .update(dbm.agentSession)
    .set({ turnStatus: "DONE_NO_ACTION", leaseOwner: null, leaseExpiresAt: null });
}

/** A report with one session and one reviewer guidance run on it. */
async function seedAbandonedSession(reportState: ReportState) {
  seq += 1;
  const n = seq;

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:1:issue:${31000 + n}`,
      title: `report ${n}`,
      body: "body",
      state: reportState,
    })
    .returning({ id: dbm.report.id });

  const [s] = await dbm.db
    .insert(dbm.agentSession)
    .values({
      reportId: r.id,
      capabilityToken: `cap-abandon-${n}`,
      sessionId: `session-abandon-${n}`,
      turnId: `turn-abandon-${n}`,
    })
    .returning({ id: dbm.agentSession.id });

  const [run] = await dbm.db
    .insert(dbm.investigationRun)
    .values({
      reportId: r.id,
      runNumber: 1,
      reason: "REVIEWER_GUIDANCE",
      status: "RUNNING",
    })
    .returning({ id: dbm.investigationRun.id });

  return { reportId: r.id, agentSessionId: s.id, runId: run.id };
}

async function sessionRow(id: string) {
  const [row] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.id, id))
    .limit(1);
  return row;
}

async function runRow(id: string) {
  const [row] = await dbm.db
    .select()
    .from(dbm.investigationRun)
    .where(dbm.eq(dbm.investigationRun.id, id))
    .limit(1);
  return row;
}

async function reportStateOf(reportId: string): Promise<string | undefined> {
  const [row] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportId))
    .limit(1);
  return row?.state;
}

test("abandonVerdictConflict ends the session and the running recheck", async () => {
  await drainSessions();
  const seed = await seedAbandonedSession("REPRODUCING");

  const lease = await queue.claim("worker-abandon", 60);
  assert.ok(lease, "the seeded session must be claimable");
  assert.equal(lease.id, seed.agentSessionId);

  await queue.abandonVerdictConflict(lease);

  const session = await sessionRow(seed.agentSessionId);
  assert.equal(session.turnStatus, "ERROR");
  assert.equal(session.lastError, "existing verdict disagreed with the retry payload");
  assert.equal(session.leaseOwner, null);
  assert.equal(session.leaseExpiresAt, null);

  // The run waited on this session. Ending only the session would leave it RUNNING
  // with nothing that could finish it, so it ends in ERROR beside the session.
  const run = await runRow(seed.runId);
  assert.equal(run.status, "ERROR");
  assert.ok(run.finishedAt, "an abandoned run is finished");
  assert.equal(run.leaseOwner, null);
  assert.equal(run.leaseExpiresAt, null);

  assert.equal(await reportStateOf(seed.reportId), "ANALYSIS_ONLY");

  const events = await dbm.db
    .select({ type: dbm.sessionEvent.type })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, seed.reportId));
  assert.equal(
    events.filter((row) => row.type === "agent.session_abandoned").length,
    1,
  );
});

test("abandonVerdictConflict keeps the report state when it is not REPRODUCING", async () => {
  await drainSessions();
  const seed = await seedAbandonedSession("ANALYSIS_ONLY");

  const lease = await queue.claim("worker-abandon-2", 60);
  assert.ok(lease, "the seeded session must be claimable");
  assert.equal(lease.id, seed.agentSessionId);

  await queue.abandonVerdictConflict(lease);

  // The session still ends, since the conflict is about the session itself.
  const session = await sessionRow(seed.agentSessionId);
  assert.equal(session.turnStatus, "ERROR");

  // With no recheck in flight, there is no run to fail and no lifecycle move to make.
  const run = await runRow(seed.runId);
  assert.equal(run.status, "RUNNING");
  assert.equal(await reportStateOf(seed.reportId), "ANALYSIS_ONLY");

  const events = await dbm.db
    .select({ type: dbm.sessionEvent.type })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, seed.reportId));
  assert.equal(
    events.filter((row) => row.type === "agent.session_abandoned").length,
    1,
  );
});
