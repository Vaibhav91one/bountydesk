import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test, { after, before, mock } from "node:test";

import type { TrueForgeClient, TurnInput } from "@/lib/trueforge/client";

/**
 * The permanent, full-loop replacement for lib/e2e/github-delivery-mechanics.test.ts's
 * stand-in approval step: intake job -> real TrueForge-backed driver -> poller discovers the
 * pending publish_verdict call -> a reviewer allows it -> the submission worker relays the
 * decision -> publish_verdict (called directly, simulating TrueForge actually invoking the
 * tool once its own turn resolves the approval) -> the existing delivery worker posts the
 * comment. TrueForge itself is faked at the TrueForgeClient seam; everything else is real.
 *
 * allowVerdict/denyVerdict need requireReviewer(), which reads the session cookie through
 * next/headers; same mock as app/review/actions.test.ts.
 */
const REVIEWER_ID = 5150;
process.env.REVIEWER_GITHUB_IDS = String(REVIEWER_ID);
process.env.AUTH_SECRET = "b".repeat(32);
process.env.TRUEFORGE_URL = "http://localhost:8790";
process.env.TRUEFORGE_API_KEY = "";

const SECRET = "e2e-approval-flow-secret";
process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;

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
let sessionLib: typeof import("@/lib/auth/session");
let POST: typeof import("@/app/api/intake/github/route").POST;
let runOnce: typeof import("@/lib/jobs/worker").runOnce;
let pollOnce: typeof import("@/lib/agent-sessions/poller").pollOnce;
let submitApprovalOnce: typeof import("@/lib/approval-submission/worker").submitApprovalOnce;
let allowVerdict: typeof import("@/app/review/actions").allowVerdict;
let denyVerdict: typeof import("@/app/review/actions").denyVerdict;
let publishVerdict: typeof import("@/lib/mcp/publish-verdict").publishVerdict;
let deliverOnce: typeof import("@/lib/delivery/worker").deliverOnce;
let createTrueforgeAnalysisDriver: typeof import("@/lib/analysis/trueforge-driver").createTrueforgeAnalysisDriver;
let computeContentHash: typeof import("@/lib/verdicts/hash").computeContentHash;

let targetProfileId: string;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("trueforge_flow");

  dbm = await import("@/lib/db");
  sessionLib = await import("@/lib/auth/session");
  ({ POST } = await import("@/app/api/intake/github/route"));
  ({ runOnce } = await import("@/lib/jobs/worker"));
  ({ pollOnce } = await import("@/lib/agent-sessions/poller"));
  ({ submitApprovalOnce } = await import("@/lib/approval-submission/worker"));
  ({ allowVerdict, denyVerdict } = await import("@/app/review/actions"));
  ({ publishVerdict } = await import("@/lib/mcp/publish-verdict"));
  ({ deliverOnce } = await import("@/lib/delivery/worker"));
  ({ createTrueforgeAnalysisDriver } = await import("@/lib/analysis/trueforge-driver"));
  ({ computeContentHash } = await import("@/lib/verdicts/hash"));

  const [profile] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: "juice-shop-v17.3.0", imageDigest: `sha256:${"1".repeat(64)}` })
    .returning({ id: dbm.targetProfile.id });
  targetProfileId = profile.id;
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function signIn(): void {
  cookieValue = sessionLib.seal({
    login: "reviewer",
    userId: REVIEWER_ID,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
}

/**
 * claim() has no per-report filter; it takes whatever due row sorts first by nextPollAt
 * across the whole table. Once more than one report has an agent_session row in this file's
 * shared schema, an earlier test's still-RUNNING session (turns stay pollable indefinitely
 * until TrueForge resolves them) can sort ahead of the report under test and eat one poll as
 * a no-op reschedule. Looping a bounded number of times, rather than asserting on a single
 * call, is what makes a later test's poll immune to an earlier test's leftover row.
 */
async function pollUntilResolved(
  client: TrueForgeClient,
  reportId: string,
  attempts = 5,
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    await pollOnce(`poll-until-resolved-${i}`, { client });
    const [row] = await dbm.db
      .select({ state: dbm.report.state })
      .from(dbm.report)
      .where(dbm.eq(dbm.report.id, reportId))
      .limit(1);
    if (row.state !== "TRIAGING" && row.state !== "REPRODUCING") return row.state;
  }
  throw new Error(`report ${reportId} never left TRIAGING/REPRODUCING after ${attempts} polls`);
}

function signedWebhook(deliveryId: string, payload: unknown): Request {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  return new Request("https://bountydesk.test/api/intake/github", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
  });
}

/**
 * Fakes only what the driver, the poller and the submission worker actually call. Extracts
 * the capability the driver embeds in its opening user.message (rather than the test
 * inventing one), so the pending call it hands back to the poller carries the exact token
 * bountydesk itself generated, the same as the real harness would echo back.
 */
type ApprovalInput = Extract<TurnInput, { type: "user.tool_approval" }>;

function fakeTrueForge(): TrueForgeClient & { submittedInputs: ApprovalInput[] } {
  const capabilityByTurn = new Map<string, string>();
  const submittedInputs: ApprovalInput[] = [];
  let turnCounter = 0;

  return {
    submittedInputs,
    async createSession() {
      return { sessionId: `truesession-${randomUUID()}` };
    },
    async deleteSession() {},
    async createTurn(_sessionId, input) {
      turnCounter += 1;
      const turnId = `trueturn-${turnCounter}`;
      const opening = input.find((item) => item.type === "user.message");
      if (opening && opening.type === "user.message") {
        const match = opening.content.match(/capability set to exactly this string: (\S+)/);
        if (match) capabilityByTurn.set(turnId, match[1]);
      }
      const approval = input.find(
        (item): item is ApprovalInput => item.type === "user.tool_approval",
      );
      if (approval) submittedInputs.push(approval);
      return { turnId, snapshot: { status: "running" } };
    },
    async getTurn(_sessionId, turnId) {
      const capability = capabilityByTurn.get(turnId);
      if (!capability) return { status: "running" };
      return {
        status: "awaiting_approval",
        pending: [
          {
            threadId: "main",
            toolCallId: "call_1",
            toolName: "publish_verdict",
            toolInfoType: "mcp",
            argumentsJson: JSON.stringify({ capability }),
          },
        ],
      };
    },
    async getTurnInput() {
      throw new Error("not used by this flow");
    },
    async findTurnByInput() {
      return null;
    },
  };
}

test("intake job -> TrueForge turn -> approval -> publish_verdict -> delivered", async () => {
  const installationId = 700_001;
  const repoId = 900_001;
  const fullName = "acme/reports-2";
  const issueNumber = 7;

  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId, accountLogin: "acme", accountId: 88 })
    .returning({ id: dbm.githubInstallation.id });

  await dbm.db.insert(dbm.connectedRepository).values({
    installationId: installation.id,
    repoId,
    fullName,
    active: true,
    targetProfileId,
  });

  const res = await POST(
    signedWebhook("delivery-flow-1", {
      action: "opened",
      issue: { number: issueNumber, title: "IDOR on order history", body: "details", user: { login: "researcher" } },
      repository: { id: repoId, full_name: fullName },
      installation: { id: installationId },
    }),
  );
  assert.equal(res.status, 202);

  const client = fakeTrueForge();
  const analysis = createTrueforgeAnalysisDriver(client);

  // Real job worker, real driver: opens the session, starts the turn, and stops there. It
  // never transitions the report itself (see trueforge-driver.ts).
  const jobId = await runOnce("e2e-flow-worker", { analysis });
  assert.ok(jobId, "the enqueued job should have been claimable");

  const [reportRow] = await dbm.db
    .select({ id: dbm.report.id, state: dbm.report.state, sourceRef: dbm.report.sourceRef })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.sourceRef, `github:${repoId}:issue:${issueNumber}`))
    .limit(1);
  assert.ok(reportRow);
  // The driver stops at RUNNING; only the poller below is allowed to move it further.
  assert.equal(reportRow.state, "TRIAGING");

  const [verdictRow] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportRow.id))
    .limit(1);
  assert.ok(verdictRow);
  assert.equal(verdictRow.outcome, "ANALYSIS_ONLY");
  assert.equal(verdictRow.contentHash, computeContentHash(verdictRow.payload));

  const [session] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportRow.id))
    .limit(1);
  assert.ok(session);
  assert.equal(session.turnId, "trueturn-1");

  // The poller: the fake already captured the turn's capability during createTurn above, so
  // this first poll goes straight to awaiting_approval. Confirms the atomic
  // TRIAGING -> ANALYSIS_ONLY -> AWAITING_APPROVAL transition happens here, not inside the
  // driver, and only once bounty-desk has independently verified a genuine pending
  // publish_verdict call.
  const polled = await pollOnce("e2e-flow-poller", { client });
  assert.equal(polled, session.id);

  const [afterPoll] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportRow.id))
    .limit(1);
  assert.equal(afterPoll.state, "AWAITING_APPROVAL");

  const [pendingSession] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportRow.id))
    .limit(1);
  assert.ok(pendingSession.pendingVerdictId);
  assert.equal(pendingSession.pendingApprovedContentHash, verdictRow.contentHash);

  // A human allows it. This only records approval_decision + approval_submission locally; it
  // never talks to TrueForge and never moves the report to DELIVERING itself.
  signIn();
  const allowed = await allowVerdict(reportRow.id, verdictRow.id);
  assert.deepEqual(allowed, { ok: true });

  const [stillAwaiting] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportRow.id))
    .limit(1);
  assert.equal(stillAwaiting.state, "AWAITING_APPROVAL");

  // The submission worker relays the decision to TrueForge and hands the session off to the
  // new chained turn.
  const submitted = await submitApprovalOnce("e2e-flow-submitter", { client });
  assert.ok(submitted);
  assert.equal(client.submittedInputs.length, 1);
  assert.deepEqual(client.submittedInputs[0], {
    type: "user.tool_approval",
    threadId: "main",
    toolCallId: "call_1",
    approval: { status: "allow" },
  });

  const [afterSubmit] = await dbm.db
    .select({
      turnId: dbm.agentSession.turnId,
      pendingVerdictId: dbm.agentSession.pendingVerdictId,
    })
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportRow.id))
    .limit(1);
  assert.equal(afterSubmit.turnId, "trueturn-2");
  assert.notEqual(afterSubmit.turnId, session.turnId);
  // Approved: the pending markers survive the submission, since publish_verdict's own
  // handler (invoked next, simulating TrueForge acting on the now-approved turn) still needs
  // them to verify the call.
  assert.equal(afterSubmit.pendingVerdictId, verdictRow.id);

  // TrueForge, having received the allow, would now actually invoke publish_verdict. Called
  // directly here since driving that through the fake client's turn state has no value this
  // test doesn't already cover above; the MCP route itself is a thin, already-tested
  // transport wrapper around this same function.
  const published = await publishVerdict(pendingSession.capabilityToken);
  assert.deepEqual(published, { ok: true });

  const [afterPublish] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportRow.id))
    .limit(1);
  assert.equal(afterPublish.state, "DELIVERING");

  let postedBody: string | undefined;
  const deliveryId = await deliverOnce("e2e-flow-delivery", {
    deps: {
      githubAppId: 123456,
      hashContent: computeContentHash,
      mintToken: async () => ({ token: "fake-installation-token", expiresAt: new Date().toISOString() }),
      listComments: async () => [],
      postComment: async (opts) => {
        postedBody = opts.body;
        return { id: 9002 };
      },
    },
  });
  assert.ok(deliveryId);
  assert.equal(postedBody, verdictRow.payload);

  const [finalReport] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportRow.id))
    .limit(1);
  assert.equal(finalReport.state, "DELIVERED");
});

test("a denied verdict never reaches publish_verdict and the report stays DENIED", async () => {
  const installationId = 700_002;
  const repoId = 900_002;
  const fullName = "acme/reports-3";
  const issueNumber = 3;

  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId, accountLogin: "acme", accountId: 89 })
    .returning({ id: dbm.githubInstallation.id });

  await dbm.db.insert(dbm.connectedRepository).values({
    installationId: installation.id,
    repoId,
    fullName,
    active: true,
    targetProfileId,
  });

  const res = await POST(
    signedWebhook("delivery-flow-2", {
      action: "opened",
      issue: { number: issueNumber, title: "XSS in profile bio", body: "details", user: { login: "researcher" } },
      repository: { id: repoId, full_name: fullName },
      installation: { id: installationId },
    }),
  );
  assert.equal(res.status, 202);

  const client = fakeTrueForge();
  const analysis = createTrueforgeAnalysisDriver(client);
  await runOnce("e2e-deny-worker", { analysis });

  const [reportRow] = await dbm.db
    .select({ id: dbm.report.id })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.sourceRef, `github:${repoId}:issue:${issueNumber}`))
    .limit(1);
  assert.ok(reportRow);

  const resolvedState = await pollUntilResolved(client, reportRow.id);
  assert.equal(resolvedState, "AWAITING_APPROVAL");

  const [verdictRow] = await dbm.db
    .select({ id: dbm.verdict.id })
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportRow.id))
    .limit(1);

  signIn();
  const denied = await denyVerdict(reportRow.id, verdictRow.id, "not in scope");
  assert.deepEqual(denied, { ok: true });

  // A denial is final on bounty-desk's side immediately, independent of TrueForge.
  const [afterDeny] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportRow.id))
    .limit(1);
  assert.equal(afterDeny.state, "DENIED");

  const submitted = await submitApprovalOnce("e2e-deny-submitter", { client });
  assert.ok(submitted);
  assert.deepEqual(client.submittedInputs[0].approval, { status: "deny", reason: "not in scope" });

  const [session] = await dbm.db
    .select({ pendingVerdictId: dbm.agentSession.pendingVerdictId })
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportRow.id))
    .limit(1);
  // Denied: pending markers are cleared once submitted, since there is nothing left for
  // publish_verdict to ever approve on this turn.
  assert.equal(session.pendingVerdictId, null);
});
