import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Auth is the point of this suite: a wrong or missing bearer header must never reach
 * publishVerdict at all. The exhaustive approval-logic coverage lives in
 * lib/mcp/publish-verdict.test.ts; this file only proves the route wiring, end to end, once.
 */
const SECRET = "mcp-route-test-secret";
process.env.MCP_SERVER_SECRET = SECRET;

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let POST: typeof import("./route").POST;
let computeContentHash: typeof import("@/lib/verdicts/hash").computeContentHash;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("mcp_publish_verdict_route");

  dbm = await import("@/lib/db");
  ({ POST } = await import("./route"));
  ({ computeContentHash } = await import("@/lib/verdicts/hash"));
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

/** A report, verdict, agent_session and matching approval_decision: a capability that
 * publishVerdict would accept, so a leak past the auth check is easy to detect. */
async function seedPublishableFixture() {
  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "manual",
      sourceRef: `manual:${randomUUID()}`,
      title: "report",
      body: "body",
      state: "AWAITING_APPROVAL",
    })
    .returning({ id: dbm.report.id });

  const verdictId = randomUUID();
  const payload = `Analysis-only result.\n<!-- bountydesk-delivery:${verdictId} -->`;
  const contentHash = computeContentHash(payload);

  await dbm.db.insert(dbm.verdict).values({
    id: verdictId,
    reportId: r.id,
    outcome: "ANALYSIS_ONLY",
    summary: "summary",
    payload,
    contentHash,
  });

  const capabilityToken = `cap-${randomUUID()}`;
  await dbm.db.insert(dbm.agentSession).values({
    reportId: r.id,
    capabilityToken,
    sessionId: `session-${randomUUID()}`,
    pendingThreadId: "thread-1",
    pendingToolCallId: "call-1",
    pendingVerdictId: verdictId,
    pendingApprovedContentHash: contentHash,
  });

  await dbm.db.insert(dbm.approvalDecision).values({
    verdictId,
    reviewer: "test-reviewer",
    decision: "APPROVED",
    payloadHash: contentHash,
    threadId: "thread-1",
    toolCallId: "call-1",
  });

  return { reportId: r.id, capabilityToken };
}

async function reportState(reportId: string): Promise<string> {
  const [row] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportId));
  return row.state;
}

function toolCallRequest(capability: string, headers: Record<string, string>): Request {
  return new Request("https://bountydesk.test/api/mcp/publish-verdict", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "publish_verdict", arguments: { capability } },
    }),
  });
}

test("a missing Authorization header is rejected before publishVerdict runs", async () => {
  const fixture = await seedPublishableFixture();

  const response = await POST(toolCallRequest(fixture.capabilityToken, {}));

  assert.equal(response.status, 401);
  assert.equal(await reportState(fixture.reportId), "AWAITING_APPROVAL");
});

test("a wrong Authorization header is rejected before publishVerdict runs", async () => {
  const fixture = await seedPublishableFixture();

  const response = await POST(
    toolCallRequest(fixture.capabilityToken, { authorization: "Bearer not-the-secret" }),
  );

  assert.equal(response.status, 401);
  assert.equal(await reportState(fixture.reportId), "AWAITING_APPROVAL");
});

test("a correct bearer header reaches publishVerdict and the report is moved to DELIVERING", async () => {
  const fixture = await seedPublishableFixture();

  const response = await POST(
    toolCallRequest(fixture.capabilityToken, { authorization: `Bearer ${SECRET}` }),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    result?: { isError?: boolean; content?: { type: string; text: string }[] };
  };
  assert.equal(body.result?.isError, undefined);
  assert.match(body.result?.content?.[0]?.text ?? "", /published/);
  assert.equal(await reportState(fixture.reportId), "DELIVERING");
});
