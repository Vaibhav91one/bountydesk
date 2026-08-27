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

/** A report already sitting in AWAITING_APPROVAL with a verdict and a live pending call. */
async function seedPendingReport({ pendingHash }: { pendingHash?: string } = {}) {
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
      pendingThreadId: `thread-${seq}`,
      pendingToolCallId: `call-${seq}`,
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

  const result = await actions.allowVerdict(reportId);
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
  assert.equal(sessionRow.pendingThreadId, null);
  assert.equal(sessionRow.pendingToolCallId, null);
  assert.equal(sessionRow.pendingVerdictId, null);
  assert.equal(sessionRow.pendingApprovedContentHash, null);

  // The load-bearing assertion: allow records a decision, it does not manufacture delivery.
  assert.equal(await reportState(reportId), "AWAITING_APPROVAL");
});

test("denyVerdict records a denial and moves the report to DENIED itself", async () => {
  signIn(REVIEWER_ID, "bob");
  const { reportId, verdictId } = await seedPendingReport();

  const result = await actions.denyVerdict(reportId, "not in scope");
  assert.equal(result.ok, true);

  const decisions = await decisionsFor(verdictId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, "DENIED");
  assert.equal(decisions[0].note, "not in scope");

  assert.equal(await reportState(reportId), "DENIED");
});

test("a double-click on allow is an idempotent no-op, not a second decision", async () => {
  signIn(REVIEWER_ID);
  const { reportId, verdictId } = await seedPendingReport();

  const first = await actions.allowVerdict(reportId);
  const second = await actions.allowVerdict(reportId);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal((await decisionsFor(verdictId)).length, 1);
});

test("denying after an allow already ran is refused and does not overwrite it", async () => {
  signIn(REVIEWER_ID);
  const { reportId, verdictId } = await seedPendingReport();

  const allowed = await actions.allowVerdict(reportId);
  assert.equal(allowed.ok, true);

  const denied = await actions.denyVerdict(reportId, "actually no");
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

  const allowed = await actions.allowVerdict(reportRow.id);
  assert.equal(allowed.ok, false);
  const denied = await actions.denyVerdict(reportRow.id);
  assert.equal(denied.ok, false);

  assert.equal((await submissionsFor(sessionRow.id)).length, 0);
  assert.equal(await reportState(reportRow.id), "AWAITING_APPROVAL");
});

test("a pinned hash that no longer matches the payload is refused before writing anything", async () => {
  signIn(REVIEWER_ID);
  const { reportId, verdictId } = await seedPendingReport({
    pendingHash: computeContentHash("a payload this verdict never actually had"),
  });

  const result = await actions.allowVerdict(reportId);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /hash mismatch/);
  assert.equal((await decisionsFor(verdictId)).length, 0);
});

test("a caller with no session never reaches the database", async () => {
  signOut();
  const { reportId, verdictId } = await seedPendingReport();

  await assert.rejects(() => actions.allowVerdict(reportId), /NEXT_REDIRECT/);
  await assert.rejects(() => actions.denyVerdict(reportId), /NEXT_REDIRECT/);

  assert.equal((await decisionsFor(verdictId)).length, 0);
  assert.equal(await reportState(reportId), "AWAITING_APPROVAL");
});

test("a signed-in caller who is not on the reviewer allowlist never reaches the database", async () => {
  signIn(999_999, "outsider");
  const { reportId, verdictId } = await seedPendingReport();

  await assert.rejects(() => actions.allowVerdict(reportId), /NEXT_REDIRECT/);

  assert.equal((await decisionsFor(verdictId)).length, 0);
});
