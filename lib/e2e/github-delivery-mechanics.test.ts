import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { after, before } from "node:test";

/**
 * Drives the real webhook route, the real job worker with the real stub analysis driver, and
 * the real delivery worker, through a faked GitHub HTTP boundary.
 *
 * There is no production approval trigger yet: the native TrueForge `publish_verdict` gate
 * (A4) is what will actually write `approval_decision` and move a report into `DELIVERING`.
 * The step marked below inserts those rows directly, standing in for a human's approval so
 * the delivery mechanics can be exercised end to end. That stand-in is test code only; nothing
 * in `app/` or `lib/` outside this file creates those rows today.
 */
const SECRET = "e2e-test-secret";
process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;

// The intake gate only enqueues on a /reproduce command from an actor on this allowlist, so
// the webhook this test posts has to carry both.
const REVIEWER_ID = 5150;
process.env.REVIEWER_GITHUB_IDS = String(REVIEWER_ID);

let schema: import("@/lib/db/testing").DisposableSchema;

// Imported dynamically, after createSchema() sets DATABASE_SCHEMA, so every pool this test
// opens (including the ones inside the route handler and the workers) points at the same
// disposable schema.
let dbm: typeof import("@/lib/db");
let POST: typeof import("@/app/api/intake/github/route").POST;
let runOnce: typeof import("@/lib/jobs/worker").runOnce;
let deliverOnce: typeof import("@/lib/delivery/worker").deliverOnce;
let stubAnalysisDriver: typeof import("@/lib/analysis/stub-driver").stubAnalysisDriver;
let computeContentHash: typeof import("@/lib/verdicts/hash").computeContentHash;
let transition: typeof import("@/lib/reports/lifecycle").transition;

let targetProfileId: string;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("e2e");

  dbm = await import("@/lib/db");
  ({ POST } = await import("@/app/api/intake/github/route"));
  ({ runOnce } = await import("@/lib/jobs/worker"));
  ({ deliverOnce } = await import("@/lib/delivery/worker"));
  ({ stubAnalysisDriver } = await import("@/lib/analysis/stub-driver"));
  ({ computeContentHash } = await import("@/lib/verdicts/hash"));
  ({ transition } = await import("@/lib/reports/lifecycle"));

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

test("a signed issue goes from webhook to a delivered GitHub comment", async () => {
  const installationId = 600_001;
  const repoId = 800_001;
  const fullName = "acme/reports-1";
  const issueNumber = 42;

  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId, accountLogin: "acme", accountId: 77 })
    .returning({ id: dbm.githubInstallation.id });

  await dbm.db.insert(dbm.connectedRepository).values({
    installationId: installation.id,
    repoId,
    fullName,
    active: true,
    targetProfileId,
  });

  // Step 1: the real, signed webhook route accepts the issue and enqueues a durable job.
  const res = await POST(
    signedWebhook("delivery-1", {
      action: "opened",
      issue: { number: issueNumber, title: "SQLi in search", body: "/reproduce\n\ndetails", user: { login: "researcher" } },
      sender: { id: REVIEWER_ID, login: "reviewer" },
      repository: { id: repoId, full_name: fullName },
      installation: { id: installationId },
    }),
  );
  assert.equal(res.status, 202);

  // Step 2: the real worker, with the real stub analysis driver, carries the job to DONE and
  // the report to AWAITING_APPROVAL with an immutable ANALYSIS_ONLY verdict.
  const jobId = await runOnce("e2e-worker", { analysis: stubAnalysisDriver });
  assert.ok(jobId, "the enqueued job should have been claimable");

  const [reportRow] = await dbm.db
    .select({ id: dbm.report.id, state: dbm.report.state, sourceRef: dbm.report.sourceRef })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.sourceRef, `github:${repoId}:issue:${issueNumber}`))
    .limit(1);
  assert.ok(reportRow);
  assert.equal(reportRow.state, "AWAITING_APPROVAL");

  const [verdictRow] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportRow.id))
    .limit(1);
  assert.ok(verdictRow);
  assert.equal(verdictRow.outcome, "ANALYSIS_ONLY");
  assert.match(verdictRow.payload, /not (?:been )?(?:performed|attempted|run)/i);
  assert.doesNotMatch(verdictRow.payload.toLowerCase(), /\b(?:is|was) reproduced\b/);
  assert.ok(verdictRow.payload.includes(`bountydesk-delivery:${verdictRow.id}`));
  assert.equal(verdictRow.contentHash, computeContentHash(verdictRow.payload));

  // Step 3: stand in for the human approval that A4's native TrueForge gate will provide.
  // This is test-only scaffolding, not a production approval path.
  await transition(reportRow.id, "AWAITING_APPROVAL", "DELIVERING");
  await dbm.db.insert(dbm.approvalDecision).values({
    verdictId: verdictRow.id,
    reviewer: "test-reviewer",
    decision: "APPROVED",
    payloadHash: verdictRow.contentHash,
  });
  const [outbound] = await dbm.db
    .insert(dbm.outboundDelivery)
    .values({
      reportId: reportRow.id,
      verdictId: verdictRow.id,
      idempotencyKey: `verdict:${verdictRow.id}`,
      target: reportRow.sourceRef,
      approvedContentHash: verdictRow.contentHash,
    })
    .returning({ id: dbm.outboundDelivery.id });

  // Step 4: the real delivery worker, against a faked GitHub HTTP boundary.
  let postedBody: string | undefined;
  const deliveryId = await deliverOnce("e2e-delivery", {
    deps: {
      githubAppId: 123456,
      hashContent: computeContentHash,
      mintToken: async () => ({ token: "fake-installation-token", expiresAt: new Date().toISOString() }),
      listComments: async () => [],
      postComment: async (opts) => {
        postedBody = opts.body;
        return { id: 9001 };
      },
    },
  });
  assert.equal(deliveryId, outbound.id);

  // The posted comment is the approved payload, byte for byte. Nothing is appended at send
  // time; the marker was already inside verdict.payload when it was hashed and approved.
  assert.equal(postedBody, verdictRow.payload);

  const [finalReport] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportRow.id))
    .limit(1);
  assert.equal(finalReport.state, "DELIVERED");

  const [finalOutbound] = await dbm.db
    .select({ state: dbm.outboundDelivery.state })
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.id, outbound.id))
    .limit(1);
  assert.equal(finalOutbound.state, "SENT");

  const attempts = await dbm.db
    .select()
    .from(dbm.deliveryAttempt)
    .where(dbm.eq(dbm.deliveryAttempt.deliveryId, outbound.id));
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].responseStatus, 201);
  for (const row of attempts) {
    for (const value of [row.responseBody, row.error]) {
      if (value) assert.doesNotMatch(value, /fake-installation-token/);
    }
  }

  // A retry finds nothing left to claim: the row is SENT, not PENDING.
  const secondAttempt = await deliverOnce("e2e-delivery-retry", {
    deps: {
      githubAppId: 123456,
      hashContent: computeContentHash,
      mintToken: async () => {
        throw new Error("should never be called: nothing is claimable");
      },
      listComments: async () => [],
      postComment: async () => {
        throw new Error("should never be called: nothing is claimable");
      },
    },
  });
  assert.equal(secondAttempt, null);
});
