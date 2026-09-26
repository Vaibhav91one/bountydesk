import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, beforeEach, mock } from "node:test";

import { computeContentHash } from "@/lib/verdicts/hash";

/**
 * Disposable-schema pattern, same as lib/jobs/queue.test.ts: every guarantee here is a
 * database one (row locks, the unique approval_decision/approval_submission indexes), so a
 * mock database would agree with a wrong implementation.
 *
 * allowVerdict and denyVerdict both start with requireReviewer(). The DAL is mocked directly
 * (rather than Clerk underneath it) so the test never loads @clerk/nextjs/server, whose
 * server-only guard and headers() call have no request scope in a plain node:test process. This
 * needs node run with --experimental-test-module-mocks, which package.json's test script carries.
 */
const REVIEWER_ID = 5150;
const REVIEWER_EMAIL = "reviewer@bountydesk.test";

type MockSession = { login: string; email: string; avatarUrl: string | null };
let session: MockSession | null = null;
let deliverCalls: { deliveryId: string; owner: string }[] = [];
mock.module("@/lib/auth/dal", {
  namedExports: {
    currentSession: async () => session,
    requireReviewer: async () => {
      if (session) return session;
      // Same as the real DAL: a missing session redirects, which throws NEXT_REDIRECT.
      const { redirect } = await import("next/navigation");
      redirect("/login");
    },
  },
});
mock.module("next/cache", {
  namedExports: {
    revalidatePath: () => undefined,
  },
});
mock.module("@/lib/delivery/worker", {
  namedExports: {
    deliverById: async (deliveryId: string, owner: string) => {
      deliverCalls.push({ deliveryId, owner });
      return deliveryId;
    },
  },
});

// The gate actions mail the reporter through sendVerdictEmail. A real send would reach Resend with
// a live key from .env.local, so it is faked here. ResendSendError and EMAIL_ASSET_ORIGIN are
// re-declared because mock.module replaces the whole module, and lib/delivery/email imports both at
// load; a plain Error from the fake is not an instance of this class, so notice.ts rethrows it and
// the gate reports the failure as a partial-send reason.
type ResendCall = { to: string; subject: string; text: string; idempotencyKey: string };
let resendCalls: ResendCall[] = [];
let resendFails = false;
class FakeResendSendError extends Error {
  readonly disposition = "transient";
}
mock.module("@/lib/email/resend", {
  namedExports: {
    sendVerdictEmail: async (opts: ResendCall) => {
      resendCalls.push({ to: opts.to, subject: opts.subject, text: opts.text, idempotencyKey: opts.idempotencyKey });
      if (resendFails) throw new Error("connection reset");
      return { id: `re_${resendCalls.length}` };
    },
    ResendSendError: FakeResendSendError,
    EMAIL_ASSET_ORIGIN: "https://app.test",
  },
});

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let actions: typeof import("./actions");
let notice: typeof import("@/lib/email/notice");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("review");

  dbm = await import("@/lib/db");
  actions = await import("./actions");
  notice = await import("@/lib/email/notice");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

beforeEach(() => {
  deliverCalls = [];
  resendCalls = [];
  resendFails = false;
});

// The first arg keeps the old shape: REVIEWER_ID is the allowlisted reviewer (the DAL would return
// a session), any other id is a non-reviewer (the DAL would return null and requireReviewer would
// redirect), so the existing call sites carry over unchanged.
function signIn(userId: number, login = "reviewer") {
  session = userId === REVIEWER_ID ? { login, email: REVIEWER_EMAIL, avatarUrl: null } : null;
}

function signOut() {
  session = null;
}

let seq = 0;

/** A report already sitting in AWAITING_APPROVAL with a verdict and a live pending call.
 * `synthesized` seeds the server-authored ANALYSIS_ONLY case instead: a verdict awaiting
 * approval with null thread/tool-call markers, because there is no TrueForge call to answer. */
async function seedPendingReport({
  pendingHash,
  synthesized,
  state,
  channel = "manual",
}: {
  pendingHash?: string;
  synthesized?: boolean;
  state?: "AWAITING_APPROVAL" | "ANALYSIS_ONLY";
  channel?: "manual" | "github";
} = {}) {
  seq += 1;
  const [reportRow] = await dbm.db
    .insert(dbm.report)
    .values({
      channel,
      sourceRef: channel === "github" ? `github:1:issue:${seq}` : `manual:${seq}`,
      title: `Report ${seq}`,
      body: "body",
      state: state ?? (synthesized ? "ANALYSIS_ONLY" : "AWAITING_APPROVAL"),
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

async function deliveriesFor(reportId: string) {
  return dbm.db
    .select()
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.reportId, reportId));
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
  const { reportId, verdictId, agentSessionId } = await seedPendingReport({
    synthesized: true,
    channel: "github",
  });

  const result = await actions.allowVerdict(reportId, verdictId);
  assert.equal(result.ok, true);

  // The decision records null thread/tool-call ids, which the approval-submission worker reads
  // as "deliver without a TrueForge round-trip".
  const decisions = await decisionsFor(verdictId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, "APPROVED");
  assert.equal(decisions[0].threadId, null);
  assert.equal(decisions[0].toolCallId, null);

  const submissions = await submissionsFor(agentSessionId);
  assert.equal(submissions.length, 0);

  const deliveries = await deliveriesFor(reportId);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].verdictId, verdictId);
  assert.equal(deliveries[0].target, `github:1:issue:${seq}`);
  assert.deepEqual(deliverCalls, [
    {
      deliveryId: deliveries[0].id,
      owner: `review-action-delivery-${deliveries[0].id}`,
    },
  ]);
  assert.equal(await reportState(reportId), "DELIVERING");
});

test("allowVerdict repairs an already approved synthesized verdict with no delivery", async () => {
  signIn(REVIEWER_ID, "erin");
  const { reportId, verdictId } = await seedPendingReport({
    synthesized: true,
    channel: "github",
  });
  const [sessionRow] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));

  await dbm.db.insert(dbm.approvalDecision).values({
    verdictId,
    reviewer: "erin",
    decision: "APPROVED",
    payloadHash: sessionRow.pendingApprovedContentHash!,
    threadId: null,
    toolCallId: null,
  });

  const result = await actions.allowVerdict(reportId, verdictId);
  assert.equal(result.ok, true);

  const decisions = await decisionsFor(verdictId);
  assert.equal(decisions.length, 1);

  const deliveries = await deliveriesFor(reportId);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliverCalls, [
    {
      deliveryId: deliveries[0].id,
      owner: `review-action-delivery-${deliveries[0].id}`,
    },
  ]);
  assert.equal(await reportState(reportId), "DELIVERING");
});

test("denyVerdict denies a synthesized verdict from the analysis lane", async () => {
  signIn(REVIEWER_ID, "dana");
  const { reportId, verdictId } = await seedPendingReport({ synthesized: true });

  const result = await actions.denyVerdict(reportId, verdictId, "the theory does not hold");
  assert.equal(result.ok, true);

  const decisions = await decisionsFor(verdictId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, "DENIED");
  assert.equal(decisions[0].threadId, null);
  assert.equal(decisions[0].toolCallId, null);
  assert.equal(await reportState(reportId), "DENIED");
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

test("approving a verdict superseded by a re-check is refused", async () => {
  signIn(REVIEWER_ID);
  const { reportId, verdictId } = await seedPendingReport();

  // A re-check superseded this verdict: the run row and link exist, the report went back to
  // REPRODUCING. A stale approval page still submits the dead verdict's id.
  const [run] = await dbm.db
    .insert(dbm.investigationRun)
    .values({ reportId, runNumber: 2, reason: "REVIEWER_GUIDANCE", status: "PENDING" })
    .returning({ id: dbm.investigationRun.id });
  await dbm.db.insert(dbm.verdictSupersession).values({
    reportId,
    oldVerdictId: verdictId,
    supersededByRunId: run.id,
    reason: "reviewer-guided-recheck",
    actor: "reviewer-1",
  });
  await dbm.db
    .update(dbm.report)
    .set({ state: "REPRODUCING" })
    .where(dbm.eq(dbm.report.id, reportId));

  const allow = await actions.allowVerdict(reportId, verdictId);
  assert.equal(allow.ok, false);
  assert.match(allow.error ?? "", /superseded/);
  assert.equal((await decisionsFor(verdictId)).length, 0);

  const deny = await actions.denyVerdict(reportId, verdictId);
  assert.equal(deny.ok, false);
  assert.match(deny.error ?? "", /superseded/);
  assert.equal((await decisionsFor(verdictId)).length, 0);
});

test("requestRecheckAction supersedes the pending verdict and opens a guidance run", async () => {
  signIn(REVIEWER_ID);
  const { reportId, verdictId } = await seedPendingReport();

  const result = await actions.requestRecheckAction(
    reportId,
    verdictId,
    "check the auth endpoints again",
  );
  assert.equal(result.ok, true);

  const [supersession] = await dbm.db
    .select()
    .from(dbm.verdictSupersession)
    .where(dbm.eq(dbm.verdictSupersession.oldVerdictId, verdictId));
  assert.ok(supersession);
  assert.equal(supersession.reason, "reviewer-guided-recheck");

  assert.equal(await reportState(reportId), "REPRODUCING");
  assert.equal((await decisionsFor(verdictId)).length, 0, "a re-check never decides anything");

  // The old verdict can no longer be approved even from a stale page.
  const stale = await actions.allowVerdict(reportId, verdictId);
  assert.equal(stale.ok, false);
  assert.match(stale.error ?? "", /superseded/);
});

test("requestRecheckAction refuses guidance from an unauthenticated caller", async () => {
  signOut();
  const { reportId, verdictId } = await seedPendingReport();

  await assert.rejects(
    () => actions.requestRecheckAction(reportId, verdictId, "look again"),
    /NEXT_REDIRECT/,
  );
  assert.equal(await reportState(reportId), "AWAITING_APPROVAL");
});

async function seedGatedReport() {
  seq += 1;
  const contact = `outsider${seq}@outside.test`;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "email",
      sourceRef: `email:<gated-${seq}@mail.test>`,
      title: `Gated ${seq}`,
      body: "body",
      state: "NEEDS_DECISION",
      reporterContact: contact,
      verifiedSender: contact,
    })
    .returning({ id: dbm.report.id });
  return { id: row.id, contact };
}

async function hasEvent(reportId: string, type: string): Promise<boolean> {
  const [row] = await dbm.db
    .select({ id: dbm.sessionEvent.id })
    .from(dbm.sessionEvent)
    .where(dbm.and(dbm.eq(dbm.sessionEvent.reportId, reportId), dbm.eq(dbm.sessionEvent.type, type)))
    .limit(1);
  return Boolean(row);
}

test("the gate actions refuse a caller who is not a reviewer, and change nothing", async () => {
  signOut();
  const { id: reportId } = await seedGatedReport();
  const { reportId: original } = await seedPendingReport();

  await assert.rejects(() => actions.rejectAtGateAction(reportId, true), /NEXT_REDIRECT/);
  await assert.rejects(() => actions.runAnalysisAction(reportId), /NEXT_REDIRECT/);
  await assert.rejects(() => actions.markDuplicateAction(reportId, original), /NEXT_REDIRECT/);

  assert.equal(await reportState(reportId), "NEEDS_DECISION");
  assert.equal(resendCalls.length, 0, "a refused caller never triggers a reply");
});

test("a reviewer's gate decision moves the report and records who made it", async () => {
  signIn(REVIEWER_ID, "gatekeeper");
  const rejected = await seedGatedReport();
  const released = await seedGatedReport();

  assert.deepEqual(await actions.rejectAtGateAction(rejected.id, false), { ok: true });
  assert.deepEqual(await actions.runAnalysisAction(released.id), { ok: true });

  assert.equal(await reportState(rejected.id), "DENIED");
  assert.equal(await reportState(released.id), "TRIAGING");
  const [event] = await dbm.db
    .select({ data: dbm.sessionEvent.data })
    .from(dbm.sessionEvent)
    .where(dbm.and(dbm.eq(dbm.sessionEvent.reportId, rejected.id), dbm.eq(dbm.sessionEvent.type, "intake.rejected")));
  assert.deepEqual(event.data, { reviewer: "gatekeeper" });

  // A malformed id never reaches the database.
  assert.equal((await actions.runAnalysisAction("not-a-uuid")).ok, false);
  assert.equal((await actions.markDuplicateAction(rejected.id, "not-a-uuid")).ok, false);
});

test("rejecting mails the fixed reply to the verified sender; marking spam stays silent", async () => {
  signIn(REVIEWER_ID, "gatekeeper");
  const rejected = await seedGatedReport();
  const spam = await seedGatedReport();

  assert.deepEqual(await actions.rejectAtGateAction(rejected.id, false), { ok: true });
  assert.equal(resendCalls.length, 1);
  assert.equal(resendCalls[0].to, rejected.contact);
  assert.equal(resendCalls[0].text, notice.NOTICES.rejected.text);
  assert.ok(await hasEvent(rejected.id, "intake.rejected_sent"));

  resendCalls = [];
  assert.deepEqual(await actions.rejectAtGateAction(spam.id, true), { ok: true });
  assert.equal(resendCalls.length, 0, "spam gets no reply");
  assert.ok(await hasEvent(spam.id, "intake.marked_spam"));
  assert.ok(!(await hasEvent(spam.id, "intake.rejected_sent")));
});

test("a reject whose reply fails after the close surfaces the reason and stays denied", async () => {
  signIn(REVIEWER_ID, "gatekeeper");
  const rejected = await seedGatedReport();
  resendFails = true;

  const result = await actions.rejectAtGateAction(rejected.id, false);

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Closed as rejected/);
  assert.equal(await reportState(rejected.id), "DENIED", "the close is not rolled back");
  assert.ok(await hasEvent(rejected.id, "intake.rejected"));
  assert.ok(!(await hasEvent(rejected.id, "intake.rejected_sent")));
});

/**
 * Replace db.transaction with a fault so the approval action meets a dropped connection. The own
 * property shadows the prototype method decide() calls, and deleting it restores the real one.
 */
function faultTransaction(fault: (call: number) => Promise<unknown> | "real") {
  const real = dbm.db.transaction.bind(dbm.db);
  let calls = 0;
  (dbm.db as { transaction: unknown }).transaction = (...args: unknown[]) => {
    calls += 1;
    const outcome = fault(calls);
    return outcome === "real" ? (real as (...a: unknown[]) => unknown)(...args) : outcome;
  };
  return {
    calls: () => calls,
    restore: () => {
      delete (dbm.db as { transaction?: unknown }).transaction;
    },
  };
}

test("allowVerdict returns a friendly error instead of throwing when the DB connection drops", async () => {
  signIn(REVIEWER_ID);
  const { reportId, verdictId } = await seedPendingReport();

  const dropped = Object.assign(new Error("Connection ended unexpectedly"), { code: "CONNECTION_ENDED" });
  // Both the initial attempt and the one retry hit a dead pooler socket.
  const fault = faultTransaction(() => Promise.reject(dropped));
  let result;
  try {
    result = await actions.allowVerdict(reportId, verdictId);
  } finally {
    fault.restore();
  }

  assert.equal(result.ok, false, "a transient DB failure must not surface as a thrown 500");
  assert.match(result.error ?? "", /database call failed/i);
  assert.equal(fault.calls(), 2, "the initial attempt plus exactly one retry");
  // The transaction rolled back both times, so nothing was recorded and the report is untouched.
  assert.equal((await decisionsFor(verdictId)).length, 0);
  assert.equal(await reportState(reportId), "AWAITING_APPROVAL");
});

test("allowVerdict retries once and records the decision when the first DB attempt drops", async () => {
  signIn(REVIEWER_ID, "iris");
  const { reportId, verdictId } = await seedPendingReport();

  const dropped = Object.assign(new Error("write CONNECTION_CLOSED"), { code: "CONNECTION_CLOSED" });
  const fault = faultTransaction((call) => (call === 1 ? Promise.reject(dropped) : "real"));
  let result;
  try {
    result = await actions.allowVerdict(reportId, verdictId);
  } finally {
    fault.restore();
  }

  assert.equal(result.ok, true);
  assert.equal(fault.calls(), 2);
  const decisions = await decisionsFor(verdictId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, "APPROVED");
});

/** A DELIVERING report whose one delivery the worker refused and held for a human. */
async function seedHeldDelivery() {
  const { reportId, verdictId } = await seedPendingReport({ synthesized: true });
  await dbm.db.update(dbm.report).set({ state: "DELIVERING" }).where(dbm.eq(dbm.report.id, reportId));
  const [verdictRow] = await dbm.db
    .select({ contentHash: dbm.verdict.contentHash })
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.id, verdictId));
  const [delivery] = await dbm.db
    .insert(dbm.outboundDelivery)
    .values({
      reportId,
      verdictId,
      idempotencyKey: `verdict:${verdictId}`,
      target: `manual:${seq}`,
      approvedContentHash: verdictRow.contentHash,
      state: "FAILED",
      requiresHumanReview: true,
      attempts: 1,
      lastError: "GitHub refused the advisory write (403)",
    })
    .returning({ id: dbm.outboundDelivery.id });
  return { reportId, deliveryId: delivery.id };
}

test("retryHeldDeliveryAction refuses a caller who is not a reviewer, and changes nothing", async () => {
  const { reportId, deliveryId } = await seedHeldDelivery();
  signOut();
  await assert.rejects(() => actions.retryHeldDeliveryAction(reportId), /NEXT_REDIRECT/);
  signIn(REVIEWER_ID + 1);
  await assert.rejects(() => actions.retryHeldDeliveryAction(reportId), /NEXT_REDIRECT/);

  const [row] = await deliveriesFor(reportId);
  assert.equal(row.id, deliveryId);
  assert.equal(row.state, "FAILED");
  assert.equal(row.requiresHumanReview, true);
  assert.equal(deliverCalls.length, 0);
});

test("retryHeldDeliveryAction re-queues the held row, records who asked, and tries it once", async () => {
  const { reportId, deliveryId } = await seedHeldDelivery();
  signIn(REVIEWER_ID, "carol");

  assert.deepEqual(await actions.retryHeldDeliveryAction(reportId), { ok: true });

  const [row] = await deliveriesFor(reportId);
  assert.equal(row.state, "PENDING");
  assert.equal(row.requiresHumanReview, false);
  assert.ok(row.maxAttempts > row.attempts, "the retry has attempts left to claim");
  assert.deepEqual(
    deliverCalls.map((c) => c.deliveryId),
    [deliveryId],
  );

  const events = await dbm.db
    .select({ type: dbm.sessionEvent.type, data: dbm.sessionEvent.data })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, reportId));
  const retried = events.find((e) => e.type === "delivery.retry_requested");
  assert.ok(retried, "the retry is on the audit trail");
  assert.equal((retried.data as { reviewer: string }).reviewer, "carol");

  // A second click finds nothing held and changes nothing.
  const again = await actions.retryHeldDeliveryAction(reportId);
  assert.equal(again.ok, false);
  assert.equal(deliverCalls.length, 1);
});
