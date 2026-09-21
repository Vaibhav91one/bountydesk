import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { computeContentHash } from "@/lib/verdicts/hash";

/**
 * Retry, cancel and sweep paths run against a real Postgres, because the
 * guarantees under test are the database's: row locks, the unique run number
 * index and the sweep predicates. A mock would agree with a wrong query.
 *
 * Each run gets a disposable schema of its own. The schema is created here,
 * the committed migrations are replayed into it, and it is dropped at the end.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

// Imported dynamically so DATABASE_SCHEMA is set before the pool is constructed.
type DbModule = typeof import("@/lib/db");
type RecheckModule = typeof import("./recheck");
type QueueModule = typeof import("./queue");

let dbm: DbModule;
let recheck: RecheckModule;
let queue: QueueModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("recheckdb");

  dbm = await import("@/lib/db");
  recheck = await import("./recheck");
  queue = await import("./queue");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

type ReportState = (typeof dbm.report.state.enumValues)[number];
type RunReason = (typeof dbm.investigationRun.reason.enumValues)[number];
type RunStatus = (typeof dbm.investigationRun.status.enumValues)[number];

/** A report in the given state, with a unique source ref per seed. */
async function seedReport(state: ReportState): Promise<string> {
  seq += 1;
  const n = seq;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:1:issue:${21000 + n}`,
      title: `report ${n}`,
      body: "body",
      state,
    })
    .returning({ id: dbm.report.id });
  return row.id;
}

/** A run row with explicit lease and timestamp fields, so reset behavior is visible. */
async function seedRun(
  reportId: string,
  opts: {
    runNumber: number;
    reason: RunReason;
    status: RunStatus;
    attempts?: number;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    leaseOwner?: string | null;
    leaseExpiresAt?: Date | null;
    createdAt?: Date;
  },
): Promise<string> {
  const [row] = await dbm.db
    .insert(dbm.investigationRun)
    .values({
      reportId,
      runNumber: opts.runNumber,
      reason: opts.reason,
      status: opts.status,
      attempts: opts.attempts ?? 0,
      startedAt: opts.startedAt ?? null,
      finishedAt: opts.finishedAt ?? null,
      leaseOwner: opts.leaseOwner ?? null,
      leaseExpiresAt: opts.leaseExpiresAt ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt, updatedAt: opts.createdAt } : {}),
    })
    .returning({ id: dbm.investigationRun.id });
  return row.id;
}

async function runRow(runId: string) {
  const [row] = await dbm.db
    .select()
    .from(dbm.investigationRun)
    .where(dbm.eq(dbm.investigationRun.id, runId))
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

async function eventsOf(reportId: string, type: string) {
  const rows = await dbm.db
    .select({ type: dbm.sessionEvent.type })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, reportId));
  return rows.filter((row) => row.type === type);
}

/**
 * Prior tests leave PENDING and RUNNING rows behind, and the sweep reads the
 * whole table. Parking everything as CANCELLED keeps one sweep test from
 * seeing another test's rows, since the sweeper never touches CANCELLED.
 */
async function drainRuns() {
  await dbm.db
    .update(dbm.investigationRun)
    .set({ status: "CANCELLED", leaseOwner: null, leaseExpiresAt: null });
}

test("retryRecheck requeues only the newest failed recheck", async () => {
  const reportId = await seedReport("REPRODUCING");
  await seedRun(reportId, { runNumber: 1, reason: "INITIAL", status: "SUPERSEDED" });
  const runId = await seedRun(reportId, {
    runNumber: 2,
    reason: "REVIEWER_GUIDANCE",
    status: "ERROR",
    attempts: 3,
    startedAt: new Date("2026-09-01T00:00:00Z"),
    finishedAt: new Date("2026-09-02T00:00:00Z"),
    leaseOwner: "worker-old",
    leaseExpiresAt: new Date(Date.now() + 600_000),
  });

  const result = await recheck.retryRecheck(reportId, runId);
  assert.ok(result.ok, `retry refused: ${result.ok ? "" : result.reason}`);

  const row = await runRow(runId);
  assert.equal(row.status, "PENDING");
  assert.equal(row.attempts, 0, "a retry starts a fresh claim budget");
  assert.equal(row.startedAt, null);
  assert.equal(row.finishedAt, null);
  assert.equal(row.leaseOwner, null);
  assert.equal(row.leaseExpiresAt, null);
  assert.equal(await reportStateOf(reportId), "REPRODUCING", "a retry parks nothing");
});

test("retryRecheck refuses an INITIAL run", async () => {
  const reportId = await seedReport("REPRODUCING");
  const runId = await seedRun(reportId, { runNumber: 1, reason: "INITIAL", status: "ERROR" });

  const result = await recheck.retryRecheck(reportId, runId);
  assert.ok(!result.ok);
  assert.match(result.reason, /not a re-check run/);
});

test("retryRecheck refuses a run that is not the latest", async () => {
  const reportId = await seedReport("REPRODUCING");
  const oldRunId = await seedRun(reportId, {
    runNumber: 1,
    reason: "REVIEWER_GUIDANCE",
    status: "ERROR",
  });
  await seedRun(reportId, { runNumber: 2, reason: "REVIEWER_GUIDANCE", status: "PENDING" });

  // The old row is failed, but resurrecting it would leave two live runs for one report.
  const result = await recheck.retryRecheck(reportId, oldRunId);
  assert.ok(!result.ok);
  assert.match(result.reason, /only the latest/);
});

test("retryRecheck refuses when the report is not REPRODUCING", async () => {
  const reportId = await seedReport("ANALYSIS_ONLY");
  const runId = await seedRun(reportId, {
    runNumber: 2,
    reason: "REVIEWER_GUIDANCE",
    status: "ERROR",
  });

  const result = await recheck.retryRecheck(reportId, runId);
  assert.ok(!result.ok);
  assert.match(result.reason, /ANALYSIS_ONLY/);
});

test("retryRecheck refuses a run that is not ERROR", async () => {
  const reportId = await seedReport("REPRODUCING");
  const runId = await seedRun(reportId, {
    runNumber: 2,
    reason: "REVIEWER_GUIDANCE",
    status: "PENDING",
  });

  const result = await recheck.retryRecheck(reportId, runId);
  assert.ok(!result.ok);
  assert.match(result.reason, /only a failed re-check/);
});

test("cancelRecheck cancels a PENDING recheck and parks the report", async () => {
  const reportId = await seedReport("REPRODUCING");
  const runId = await seedRun(reportId, {
    runNumber: 2,
    reason: "REVIEWER_GUIDANCE",
    status: "PENDING",
  });

  const result = await recheck.cancelRecheck(reportId, runId);
  assert.ok(result.ok, `cancel refused: ${result.ok ? "" : result.reason}`);

  const row = await runRow(runId);
  assert.equal(row.status, "CANCELLED");
  assert.ok(row.finishedAt, "a cancelled run is finished");
  assert.equal(row.leaseOwner, null);
  assert.equal(row.leaseExpiresAt, null);
  assert.equal(await reportStateOf(reportId), "ANALYSIS_ONLY");
  assert.equal((await eventsOf(reportId, "agent.recheck_cancelled")).length, 1);
});

test("cancelRecheck cancels an ERROR recheck and parks the report", async () => {
  const reportId = await seedReport("REPRODUCING");
  const runId = await seedRun(reportId, {
    runNumber: 2,
    reason: "REVIEWER_GUIDANCE",
    status: "ERROR",
  });

  const result = await recheck.cancelRecheck(reportId, runId);
  assert.ok(result.ok, `cancel refused: ${result.ok ? "" : result.reason}`);

  const row = await runRow(runId);
  assert.equal(row.status, "CANCELLED");
  assert.equal(await reportStateOf(reportId), "ANALYSIS_ONLY");
  assert.equal((await eventsOf(reportId, "agent.recheck_cancelled")).length, 1);
});

test("cancelRecheck refuses a RUNNING recheck", async () => {
  const reportId = await seedReport("REPRODUCING");
  const runId = await seedRun(reportId, {
    runNumber: 2,
    reason: "REVIEWER_GUIDANCE",
    status: "RUNNING",
    leaseOwner: "worker-a",
    leaseExpiresAt: new Date(Date.now() + 600_000),
  });

  // A live run has a claimant; cancelling under it would strand that worker.
  const result = await recheck.cancelRecheck(reportId, runId);
  assert.ok(!result.ok);
  assert.match(result.reason, /only a pending or failed/);
});

test("cancelRecheck refuses a run that is not REVIEWER_GUIDANCE", async () => {
  const reportId = await seedReport("REPRODUCING");
  const runId = await seedRun(reportId, {
    runNumber: 1,
    reason: "INITIAL",
    status: "PENDING",
  });

  const result = await recheck.cancelRecheck(reportId, runId);
  assert.ok(!result.ok);
  assert.match(result.reason, /not a re-check run/);
});

test("cancelRecheck refuses a run that is not the latest", async () => {
  const reportId = await seedReport("REPRODUCING");
  const oldRunId = await seedRun(reportId, {
    runNumber: 2,
    reason: "REVIEWER_GUIDANCE",
    status: "ERROR",
  });
  await seedRun(reportId, { runNumber: 3, reason: "REVIEWER_GUIDANCE", status: "PENDING" });

  // Parking the report would strand the newer run, so the stale one stays put.
  const result = await recheck.cancelRecheck(reportId, oldRunId);
  assert.ok(!result.ok);
  assert.match(result.reason, /only the latest re-check can be cancelled/);

  const row = await runRow(oldRunId);
  assert.equal(row.status, "ERROR");
  assert.equal(await reportStateOf(reportId), "REPRODUCING");
  assert.equal((await eventsOf(reportId, "agent.recheck_cancelled")).length, 0);
});

test("cancelRecheck cancels the latest of two rechecks", async () => {
  const reportId = await seedReport("REPRODUCING");
  await seedRun(reportId, { runNumber: 2, reason: "REVIEWER_GUIDANCE", status: "ERROR" });
  const runId = await seedRun(reportId, {
    runNumber: 3,
    reason: "REVIEWER_GUIDANCE",
    status: "PENDING",
  });

  const result = await recheck.cancelRecheck(reportId, runId);
  assert.ok(result.ok, `cancel refused: ${result.ok ? "" : result.reason}`);

  const row = await runRow(runId);
  assert.equal(row.status, "CANCELLED");
  assert.equal(await reportStateOf(reportId), "ANALYSIS_ONLY");
  assert.equal((await eventsOf(reportId, "agent.recheck_cancelled")).length, 1);
});

/** A report with an ANALYSIS_ONLY verdict and, unless asked otherwise, a parked pending tuple. */
async function seedParkedAnalysisOnly(opts: {
  state?: ReportState;
  withPending?: boolean;
}): Promise<{ reportId: string; verdictId: string }> {
  const reportId = await seedReport(opts.state ?? "ANALYSIS_ONLY");
  const payload = `analysis payload ${seq}`;
  const contentHash = computeContentHash(payload);
  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId,
      outcome: "ANALYSIS_ONLY",
      summary: "summary",
      payload,
      contentHash,
    })
    .returning({ id: dbm.verdict.id });
  const withPending = opts.withPending ?? true;
  await dbm.db.insert(dbm.agentSession).values({
    reportId,
    capabilityToken: `cap-recheck-${seq}`,
    sessionId: `session-recheck-${seq}`,
    turnStatus: "AWAITING_APPROVAL_HARNESS",
    pendingThreadId: withPending ? `thread-recheck-${seq}` : null,
    pendingToolCallId: withPending ? `call-recheck-${seq}` : null,
    pendingVerdictId: withPending ? v.id : null,
    pendingApprovedContentHash: withPending ? contentHash : null,
  });
  return { reportId, verdictId: v.id };
}

test("requestRecheck from ANALYSIS_ONLY with a parked verdict opens a guidance run", async () => {
  const { reportId, verdictId } = await seedParkedAnalysisOnly({});

  const result = await recheck.requestRecheck(reportId, verdictId, "check the auth flow again", "reviewer-1");
  if (!result.ok) assert.fail(`re-check refused: ${result.reason}`);

  assert.equal(await reportStateOf(reportId), "REPRODUCING");
  const run = await runRow(result.runId);
  assert.equal(run.status, "PENDING");
  assert.equal(run.reason, "REVIEWER_GUIDANCE");

  const [session] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId))
    .limit(1);
  assert.equal(session.pendingVerdictId, null, "the parked tuple is cleared");
  assert.equal(session.turnStatus, "CANCELLED");
});

test("requestRecheck from ANALYSIS_ONLY without a parked verdict is refused", async () => {
  const { reportId, verdictId } = await seedParkedAnalysisOnly({ withPending: false });

  const result = await recheck.requestRecheck(reportId, verdictId, "check the auth flow again", "reviewer-1");
  assert.ok(!result.ok);
  assert.match(result.reason, /not the pending one/);
  assert.equal(await reportStateOf(reportId), "ANALYSIS_ONLY");
});

test("requestRecheck from DELIVERED is still refused", async () => {
  const { reportId, verdictId } = await seedParkedAnalysisOnly({ state: "DELIVERED" });

  const result = await recheck.requestRecheck(reportId, verdictId, "check the auth flow again", "reviewer-1");
  assert.ok(!result.ok);
  assert.match(result.reason, /only a pending approval/);
});

test("sweepRecheckRuns fails a stale PENDING run and leaves fresh work alone", async () => {
  await drainRuns();
  const now = new Date();
  const staleAt = new Date(now.getTime() - queue.RECHECK_PENDING_TIMEOUT_MS - 60_000);

  const staleReportId = await seedReport("REPRODUCING");
  const staleRunId = await seedRun(staleReportId, {
    runNumber: 1,
    reason: "REVIEWER_GUIDANCE",
    status: "PENDING",
    createdAt: staleAt,
  });

  const freshReportId = await seedReport("REPRODUCING");
  const freshRunId = await seedRun(freshReportId, {
    runNumber: 1,
    reason: "REVIEWER_GUIDANCE",
    status: "PENDING",
    createdAt: now,
  });

  const runningReportId = await seedReport("REPRODUCING");
  const runningRunId = await seedRun(runningReportId, {
    runNumber: 1,
    reason: "REVIEWER_GUIDANCE",
    status: "RUNNING",
    attempts: 1,
    leaseOwner: "worker-a",
    leaseExpiresAt: new Date(now.getTime() + 600_000),
    createdAt: now,
  });

  const result = await queue.sweepRecheckRuns(now);
  assert.equal(result.failed, 1, "only the stale pending run should fail");
  assert.equal(result.released, 0, "no expired running lease was seeded");

  const stale = await runRow(staleRunId);
  assert.equal(stale.status, "ERROR");
  assert.ok(stale.finishedAt, "a swept run is finished");
  assert.equal((await eventsOf(staleReportId, "agent.recheck_failed")).length, 1);

  const fresh = await runRow(freshRunId);
  assert.equal(fresh.status, "PENDING", "a fresh pending run waits for its claimant");

  const running = await runRow(runningRunId);
  assert.equal(running.status, "RUNNING", "a leased running run keeps its worker");
  assert.equal(running.leaseOwner, "worker-a");
});
