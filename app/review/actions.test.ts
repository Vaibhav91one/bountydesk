import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, mock } from "node:test";

import { computeContentHash } from "@/lib/verdicts/hash";

/**
 * Disposable-schema pattern, same as lib/jobs/queue.test.ts: every guarantee here is a
 * database one (row locks, the unique approval_decision/approval_submission indexes), so a
 * mock database would agree with a wrong implementation.
 *
 * allowVerdict and denyVerdict both start with requireReviewer(), which reads the session
 * cookie through next/headers. That call has no request scope in a plain node:test process
 * (cookies() throws "called outside a request scope" there), so next/headers is mocked here
 * with a settable cookie value. This needs node run with --experimental-test-module-mocks,
 * which is why package.json's test script carries that flag.
 */
const REVIEWER_ID = 5150;
process.env.REVIEWER_GITHUB_IDS = String(REVIEWER_ID);
process.env.AUTH_SECRET = "b".repeat(32);

let cookieValue: string | undefined;
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({
      get: (name: string) => (cookieValue ? { name, value: cookieValue } : undefined),
    }),
  },
});

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let actions: typeof import("./actions");
let sessionLib: typeof import("@/lib/auth/session");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("review");

  dbm = await import("@/lib/db");
  actions = await import("./actions");
  sessionLib = await import("@/lib/auth/session");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function signIn(userId: number, login = "reviewer") {
  cookieValue = sessionLib.seal({
    login,
    userId,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
}

function signOut() {
  cookieValue = undefined;
}

let seq = 0;

/** A report already sitting in AWAITING_APPROVAL with a verdict and a live pending call.
 * `synthesized` seeds the server-authored ANALYSIS_ONLY case instead: a verdict awaiting
 * approval with null thread/tool-call markers, because there is no TrueForge call to answer. */
async function seedPendingReport({
  pendingHash,
  synthesized,
}: { pendingHash?: string; synthesized?: boolean } = {}) {
  seq += 1;
  const [reportRow] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "manual",
      sourceRef: `manual:${seq}`,
      title: `Report ${seq}`,
      body: "body",
      state: "AWAITING_APPROVAL",
    })
    .returning({ id: dbm.report.id });

  const verdictId = randomUUID();
  const payload = `analysis text for report ${seq}\n\n<!-- bountydesk-delivery:${verdictId} -->`;
  const contentHash = computeContentHash(payload);

  await dbm.db.insert(dbm.verdict).values({
    id: verdictId,
    reportId: reportRow.id,
    outcome: "ANALYSIS_ONLY",
    summary: "summary",
    payload,
    contentHash,
  });

  const [sessionRow] = await dbm.db
    .insert(dbm.agentSession)
    .values({
      reportId: reportRow.id,
      capabilityToken: `cap-${seq}`,
      sessionId: `sess-${seq}`,
      pendingThreadId: synthesized ? null : `thread-${seq}`,
      pendingToolCallId: synthesized ? null : `call-${seq}`,
      pendingVerdictId: verdictId,
      // pendingHash lets the tampering test pin a hash that does not match the payload it
      // actually inserted, standing in for a payload changed after approval was set up.
      // verdict rows cannot be UPDATEd after the fact (that table refuses it at the
      // database level), so a mismatch has to be seeded this way rather than mutated in.
      pendingApprovedContentHash: pendingHash ?? contentHash,
    })
    .returning({ id: dbm.agentSession.id });

  return { reportId: reportRow.id, verdictId, agentSessionId: sessionRow.id };
}

async function decisionsFor(verdictId: string) {
  return dbm.db
    .select()
    .from(dbm.approvalDecision)
    .where(dbm.eq(dbm.approvalDecision.verdictId, verdictId));
}

async function submissionsFor(agentSessionId: string) {
  return dbm.db
    .select()
    .from(dbm.approvalSubmission)
    .where(dbm.eq(dbm.approvalSubmission.agentSessionId, agentSessionId));
}

async function reportState(reportId: string) {
  const [row] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportId));
  return row?.state;
}

test("allowVerdict records an approval but never moves the report itself", async () => {
  signIn(REVIEWER_ID, "alice");
  const { reportId, verdictId, agentSessionId } = await seedPendingReport();

  const result = await actions.allowVerdict(reportId, verdictId);
  assert.equal(result.ok, true);

  const decisions = await decisionsFor(verdictId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, "APPROVED");
  assert.equal(decisions[0].reviewer, "alice");
  assert.equal(decisions[0].threadId, `thread-${seq}`);
  assert.equal(decisions[0].toolCallId, `call-${seq}`);

  const submissions = await submissionsFor(agentSessionId);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].state, "PENDING");
  assert.equal(submissions[0].approvalDecisionId, decisions[0].id);

  const [sessionRow] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.id, agentSessionId));
  assert.equal(sessionRow.pendingThreadId, `thread-${seq}`);
  assert.equal(sessionRow.pendingToolCallId, `call-${seq}`);
  assert.equal(sessionRow.pendingVerdictId, verdictId);
  assert.equal(sessionRow.pendingApprovedContentHash, decisions[0].payloadHash);

  // The load-bearing assertion: allow records a decision, it does not manufacture delivery.
  assert.equal(await reportState(reportId), "AWAITING_APPROVAL");
});

test("allowVerdict approves a synthesized verdict with null thread/tool-call markers", async () => {
  signIn(REVIEWER_ID, "carol");
  const { reportId, verdictId, agentSessionId } = await seedPendingReport({ synthesized: true });

  const result = await actions.allowVerdict(reportId, verdictId);
  assert.equal(result.ok, true);

  // The decision records null thread/tool-call ids, which the approval-submission worker reads
  // as "deliver without a TrueForge round-trip".
  const decisions = await decisionsFor(verdictId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, "APPROVED");
  assert.equal(decisions[0].threadId, null);
  assert.equal(decisions[0].toolCallId, null);

  // The submission is still enqueued, exactly as the agent path enqueues it.
  const submissions = await submissionsFor(agentSessionId);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].state, "PENDING");

  assert.equal(await reportState(reportId), "AWAITING_APPROVAL");
});

test("denyVerdict records a denial, preserves its pending binding, and moves the report to DENIED", async () => {
  signIn(REVIEWER_ID, "bob");
  const { reportId, verdictId, agentSessionId } = await seedPendingReport();

  const result = await actions.denyVerdict(reportId, verdictId, "not in scope");
  assert.equal(result.ok, true);

  const decisions = await decisionsFor(verdictId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, "DENIED");
  assert.equal(decisions[0].note, "not in scope");

  const [sessionRow] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.id, agentSessionId));
  assert.equal(sessionRow.pendingThreadId, decisions[0].threadId);
  assert.equal(sessionRow.pendingToolCallId, decisions[0].toolCallId);
  assert.equal(sessionRow.pendingVerdictId, verdictId);
  assert.equal(sessionRow.pendingApprovedContentHash, decisions[0].payloadHash);

  assert.equal(await reportState(reportId), "DENIED");
});

test("a double-click on allow is an idempotent no-op, not a second decision", async () => {
  signIn(REVIEWER_ID);
  const { reportId, verdictId } = await seedPendingReport();

  const first = await actions.allowVerdict(reportId, verdictId);
  const second = await actions.allowVerdict(reportId, verdictId);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal((await decisionsFor(verdictId)).length, 1);
});

test("denying after an allow already ran is refused and does not overwrite it", async () => {
  signIn(REVIEWER_ID);
  const { reportId, verdictId } = await seedPendingReport();

  const allowed = await actions.allowVerdict(reportId, verdictId);
  assert.equal(allowed.ok, true);

  const denied = await actions.denyVerdict(reportId, verdictId, "actually no");
  assert.equal(denied.ok, false);

  const decisions = await decisionsFor(verdictId);
  assert.equal(decisions.length, 1, "the first decision must not be overwritten");
  assert.equal(decisions[0].decision, "APPROVED");
  assert.equal(await reportState(reportId), "AWAITING_APPROVAL", "left where allow put it");
});

test("acting on a report with no pending markers is refused and writes nothing", async () => {
  signIn(REVIEWER_ID);
  seq += 1;
  const [reportRow] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "manual",
      sourceRef: `manual:${seq}`,
      title: `Report ${seq}`,
      body: "body",
      state: "AWAITING_APPROVAL",
    })
    .returning({ id: dbm.report.id });

  const [sessionRow] = await dbm.db
    .insert(dbm.agentSession)
    .values({
      reportId: reportRow.id,
      capabilityToken: `cap-${seq}`,
      sessionId: `sess-${seq}`,
    })
    .returning({ id: dbm.agentSession.id });

  const noVerdictId = randomUUID();
  const allowed = await actions.allowVerdict(reportRow.id, noVerdictId);
  assert.equal(allowed.ok, false);
  const denied = await actions.denyVerdict(reportRow.id, noVerdictId);
  assert.equal(denied.ok, false);

  assert.equal((await submissionsFor(sessionRow.id)).length, 0);
  assert.equal(await reportState(reportRow.id), "AWAITING_APPROVAL");
});

test("a pinned hash that no longer matches the payload is refused before writing anything", async () => {
  signIn(REVIEWER_ID);
  const { reportId, verdictId } = await seedPendingReport({
    pendingHash: computeContentHash("a payload this verdict never actually had"),
  });

  const result = await actions.allowVerdict(reportId, verdictId);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /hash mismatch/);
  assert.equal((await decisionsFor(verdictId)).length, 0);
});

test("approving a verdict that is no longer the one pending is refused, not silently redirected", async () => {
  signIn(REVIEWER_ID);
  const { reportId, verdictId, agentSessionId } = await seedPendingReport();

  // Simulate a new pending call replacing the one the reviewer's page rendered: a different
  // verdict now sits in agent_session.pending_verdict_id. The reviewer's stale page still
  // submits the *old* verdict id it was actually shown.
  const newVerdictId = randomUUID();
  const newPayload = `a newer analysis\n\n<!-- bountydesk-delivery:${newVerdictId} -->`;
  await dbm.db.insert(dbm.verdict).values({
    id: newVerdictId,
    reportId,
    outcome: "ANALYSIS_ONLY",
    summary: "summary",
    payload: newPayload,
    contentHash: computeContentHash(newPayload),
    // seedPendingReport already inserted this report's revision 1; (report_id, revision) is
    // unique, so the "newer" verdict standing in for a real revision needs its own number.
    revision: 2,
  });
  await dbm.db
    .update(dbm.agentSession)
    .set({ pendingVerdictId: newVerdictId, pendingApprovedContentHash: computeContentHash(newPayload) })
    .where(dbm.eq(dbm.agentSession.id, agentSessionId));

  const result = await actions.allowVerdict(reportId, verdictId);

  assert.equal(result.ok, false);
  assert.equal((await decisionsFor(verdictId)).length, 0);
  assert.equal((await decisionsFor(newVerdictId)).length, 0);
  assert.equal(await reportState(reportId), "AWAITING_APPROVAL");
});

test("a report that left AWAITING_APPROVAL before the click is refused, not approved", async () => {
  signIn(REVIEWER_ID);
  const { reportId, verdictId } = await seedPendingReport();

  // The report moved on (cancelled) between the page rendering and the reviewer's click.
  await dbm.db
    .update(dbm.report)
    .set({ state: "CANCELLED" })
    .where(dbm.eq(dbm.report.id, reportId));

  const result = await actions.allowVerdict(reportId, verdictId);

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no longer awaiting approval/);
  assert.equal((await decisionsFor(verdictId)).length, 0);
  assert.equal(await reportState(reportId), "CANCELLED", "must not be disturbed");
});

test("a verdict id that belongs to a different report is refused", async () => {
  signIn(REVIEWER_ID);
  const a = await seedPendingReport();
  const b = await seedPendingReport();

  const result = await actions.allowVerdict(a.reportId, b.verdictId);

  assert.equal(result.ok, false);
  assert.equal((await decisionsFor(b.verdictId)).length, 0);
  assert.equal(await reportState(a.reportId), "AWAITING_APPROVAL");
  assert.equal(await reportState(b.reportId), "AWAITING_APPROVAL");
});

test("a caller with no session never reaches the database", async () => {
  signOut();
  const { reportId, verdictId } = await seedPendingReport();

  await assert.rejects(() => actions.allowVerdict(reportId, verdictId), /NEXT_REDIRECT/);
  await assert.rejects(() => actions.denyVerdict(reportId, verdictId), /NEXT_REDIRECT/);

  assert.equal((await decisionsFor(verdictId)).length, 0);
  assert.equal(await reportState(reportId), "AWAITING_APPROVAL");
});

test("a signed-in caller who is not on the reviewer allowlist never reaches the database", async () => {
  signIn(999_999, "outsider");
  const { reportId, verdictId } = await seedPendingReport();

  await assert.rejects(() => actions.allowVerdict(reportId, verdictId), /NEXT_REDIRECT/);

  assert.equal((await decisionsFor(verdictId)).length, 0);
});
