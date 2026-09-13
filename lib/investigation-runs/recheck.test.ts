import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { computeContentHash } from "@/lib/verdicts/hash";

/**
 * requestRecheck runs against a real Postgres, like lib/agent-sessions/poller.test.ts: the
 * guarantees it asserts are row locks, unique constraints, and the state graph, none of which a
 * mock can vouch for. Each run gets a disposable schema replayed with the real migrations.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

type DbModule = typeof import("@/lib/db");
type RecheckModule = typeof import("./recheck");

let dbm: DbModule;
let recheck: RecheckModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("recheck");

  dbm = await import("@/lib/db");
  recheck = await import("./recheck");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

/** A report at AWAITING_APPROVAL with a pending verdict, the minimum re-check precondition. */
async function seedAwaitingApproval() {
  seq += 1;
  const n = seq;
  const payload = `payload ${n}`;

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:1:issue:${9000 + n}`,
      title: `report ${n}`,
      body: "body",
      state: "AWAITING_APPROVAL",
    })
    .returning({ id: dbm.report.id });

  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: r.id,
      outcome: "REPRODUCED",
      summary: "summary",
      payload,
      contentHash: computeContentHash(payload),
    })
    .returning({ id: dbm.verdict.id });

  const [s] = await dbm.db
    .insert(dbm.agentSession)
    .values({
      reportId: r.id,
      capabilityToken: `cap-${n}`,
      sessionId: `session-${n}`,
      turnId: `turn-${n}`,
      turnStatus: "AWAITING_APPROVAL_HARNESS",
      pendingThreadId: `thread-${n}`,
      pendingToolCallId: `call-${n}`,
      pendingVerdictId: v.id,
      pendingApprovedContentHash: computeContentHash(payload),
    })
    .returning({ id: dbm.agentSession.id });

  return { reportId: r.id, verdictId: v.id, agentSessionId: s.id };
}

async function runRows(reportId: string) {
  return dbm.db
    .select({
      id: dbm.investigationRun.id,
      runNumber: dbm.investigationRun.runNumber,
      reason: dbm.investigationRun.reason,
      status: dbm.investigationRun.status,
      parentRunId: dbm.investigationRun.parentRunId,
      guidanceHash: dbm.investigationRun.guidanceHash,
    })
    .from(dbm.investigationRun)
    .where(dbm.eq(dbm.investigationRun.reportId, reportId))
    .orderBy(dbm.investigationRun.runNumber);
}

async function sessionRow(agentSessionId: string) {
  const [row] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.id, agentSessionId))
    .limit(1);
  return row;
}

test("recheck supersedes the active verdict without mutating it", async () => {
  const seed = await seedAwaitingApproval();
  const before = await dbm.db
    .select({ payload: dbm.verdict.payload, contentHash: dbm.verdict.contentHash })
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.id, seed.verdictId))
    .limit(1);

  const result = await recheck.requestRecheck(
    seed.reportId,
    seed.verdictId,
    "Check auth responses from another angle",
    "reviewer-1",
  );
  assert.ok(result.ok, `recheck refused: ${result.ok ? "" : result.reason}`);

  const after = await dbm.db
    .select({ payload: dbm.verdict.payload, contentHash: dbm.verdict.contentHash })
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.id, seed.verdictId))
    .limit(1);
  assert.deepEqual(after, before, "the verdict row must never be mutated by a re-check");

  const [supersession] = await dbm.db
    .select()
    .from(dbm.verdictSupersession)
    .where(dbm.eq(dbm.verdictSupersession.oldVerdictId, seed.verdictId))
    .limit(1);
  assert.ok(supersession, "a supersession link must exist");
  assert.equal(supersession.reason, "reviewer-guided-recheck");
  assert.equal(supersession.actor, "reviewer-1");
  assert.equal(supersession.supersededByRunId, result.runId);

  const runs = await runRows(seed.reportId);
  assert.equal(runs.length, 2, "one backfilled INITIAL run plus the new guidance run");
  assert.equal(runs[0].reason, "INITIAL");
  assert.equal(runs[0].status, "SUPERSEDED");
  assert.equal(runs[1].reason, "REVIEWER_GUIDANCE");
  assert.equal(runs[1].status, "PENDING");
  assert.equal(runs[1].runNumber, 2);
  assert.equal(runs[1].parentRunId, runs[0].id);
  assert.equal(runs[1].guidanceHash, recheck.guidanceHash("Check auth responses from another angle"));

  const [reportRow] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, seed.reportId))
    .limit(1);
  assert.equal(reportRow.state, "REPRODUCING");

  const session = await sessionRow(seed.agentSessionId);
  assert.equal(session.pendingVerdictId, null, "pending tuple must be cleared");
  assert.equal(session.pendingThreadId, null);
  assert.equal(session.pendingToolCallId, null);
});

test("a superseded verdict can no longer be rechecked or approved", async () => {
  const seed = await seedAwaitingApproval();
  const first = await recheck.requestRecheck(seed.reportId, seed.verdictId, "look again", "reviewer-1");
  assert.ok(first.ok);

  const second = await recheck.requestRecheck(seed.reportId, seed.verdictId, "look again harder", "reviewer-1");
  assert.ok(!second.ok);
  assert.match(second.reason, /superseded/);

  const [decision] = await dbm.db
    .select({ id: dbm.approvalDecision.id })
    .from(dbm.approvalDecision)
    .where(dbm.eq(dbm.approvalDecision.verdictId, seed.verdictId))
    .limit(1);
  assert.equal(decision, undefined, "recheck must never create an approval decision");
});

test("recheck refuses a verdict that already has a decision", async () => {
  const seed = await seedAwaitingApproval();
  await dbm.db.insert(dbm.approvalDecision).values({
    verdictId: seed.verdictId,
    reviewer: "reviewer-1",
    decision: "APPROVED",
    payloadHash: (await dbm.db.select({ h: dbm.verdict.contentHash }).from(dbm.verdict).where(dbm.eq(dbm.verdict.id, seed.verdictId)).limit(1))[0].h,
  });

  const result = await recheck.requestRecheck(seed.reportId, seed.verdictId, "look again", "reviewer-1");
  assert.ok(!result.ok);
  assert.match(result.reason, /decision/);
});

test("recheck refuses a report not at AWAITING_APPROVAL", async () => {
  const seed = await seedAwaitingApproval();
  await dbm.db
    .update(dbm.report)
    .set({ state: "DELIVERED" })
    .where(dbm.eq(dbm.report.id, seed.reportId));

  const result = await recheck.requestRecheck(seed.reportId, seed.verdictId, "look again", "reviewer-1");
  assert.ok(!result.ok);
  assert.match(result.reason, /DELIVERED/);
});

test("recheck refuses when the pending tuple points elsewhere", async () => {
  const seed = await seedAwaitingApproval();
  const [other] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: seed.reportId,
      outcome: "ANALYSIS_ONLY",
      summary: "other",
      payload: "other payload",
      contentHash: "hash-other",
      revision: 2,
    })
    .returning({ id: dbm.verdict.id });

  const result = await recheck.requestRecheck(seed.reportId, other.id, "look again", "reviewer-1");
  assert.ok(!result.ok);
  assert.match(result.reason, /not the pending one/);
});

test("recheck refuses empty and oversize guidance", async () => {
  const seed = await seedAwaitingApproval();
  const empty = await recheck.requestRecheck(seed.reportId, seed.verdictId, "   ", "reviewer-1");
  assert.ok(!empty.ok);
  assert.match(empty.reason, /guidance/i);

  const oversize = await recheck.requestRecheck(seed.reportId, seed.verdictId, "x".repeat(recheck.GUIDANCE_MAX_LENGTH + 1), "reviewer-1");
  assert.ok(!oversize.ok);
  assert.match(oversize.reason, /guidance/i);
});

test("guidance is normalized before hashing", async () => {
  const seed = await seedAwaitingApproval();
  const withControlChars = "look  at  /login\r\nagain";
  const result = await recheck.requestRecheck(seed.reportId, seed.verdictId, withControlChars, "reviewer-1");
  assert.ok(result.ok, `expected ok, got ${result.ok ? "" : result.reason}`);

  const [run] = await dbm.db
    .select({ guidanceHash: dbm.investigationRun.guidanceHash })
    .from(dbm.investigationRun)
    .where(dbm.eq(dbm.investigationRun.id, result.runId))
    .limit(1);
  // Control characters stripped, CRLF folded, then hashed: the stored hash is of the safe text.
  assert.equal(run.guidanceHash, recheck.guidanceHash("look at  /login\nagain"));
});
