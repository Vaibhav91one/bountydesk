import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, beforeEach, mock } from "node:test";

import { computeContentHash } from "@/lib/verdicts/hash";

/**
 * The mobile API against a disposable schema. The DAL and the writer check are mocked so
 * the test controls who is calling; everything under them (the route handlers, `decide`, the
 * queries) is real, because the guarantees here are the gate's and the database's.
 *
 * Clerk's own bearer-token verification is not exercised: it lives in clerkMiddleware, which a
 * plain node:test process cannot run. These tests start from what the DAL returns once it has.
 */
type Caller = {
  userId: string | null;
  session: { login: string; email: string; avatarUrl: string | null; role: "owner" | "member" | "read_only" } | null;
};
let caller: Caller = { userId: null, session: null };

mock.module("@/lib/auth/dal", {
  namedExports: {
    signedInUserId: async () => caller.userId,
    currentSession: async () => caller.session,
    clerkProfile: async () => ({ login: "outsider", email: "outsider@example.test", avatarUrl: null }),
  },
});
mock.module("@/lib/auth/reviewers", {
  namedExports: { isReviewerWriter: async () => caller.session !== null && caller.session.role !== "read_only" },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
mock.module("@/lib/delivery/worker", { namedExports: { deliverById: async (id: string) => id } });

const reviewer = { login: "alice", email: "alice@bountydesk.test", avatarUrl: null, role: "member" as const };
const asReviewer = () => (caller = { userId: "user_1", session: reviewer });
const asReadOnly = () => (caller = { userId: "user_2", session: { ...reviewer, role: "read_only" } });
const asOutsider = () => (caller = { userId: "user_3", session: null });
const asAnonymous = () => (caller = { userId: null, session: null });

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let me: typeof import("./me/route");
let home: typeof import("./home/route");
let queue: typeof import("./queue/route");
let reports: typeof import("./reports/route");
let reportCase: typeof import("./reports/[id]/route");
let approve: typeof import("./reports/[id]/approve/route");
let deny: typeof import("./reports/[id]/deny/route");
let chat: typeof import("./reports/[id]/chat/route");
let connections: typeof import("./connections/route");
let integrations: typeof import("./integrations/route");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("mobileapi");
  dbm = await import("@/lib/db");
  me = await import("./me/route");
  home = await import("./home/route");
  queue = await import("./queue/route");
  reports = await import("./reports/route");
  reportCase = await import("./reports/[id]/route");
  approve = await import("./reports/[id]/approve/route");
  deny = await import("./reports/[id]/deny/route");
  chat = await import("./reports/[id]/chat/route");
  connections = await import("./connections/route");
  integrations = await import("./integrations/route");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

beforeEach(asReviewer);

let seq = 0;

async function seedPendingReport() {
  seq += 1;
  const [reportRow] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "manual",
      sourceRef: `manual:mobile-${seq}`,
      title: `Mobile report ${seq}`,
      body: "body",
      state: "AWAITING_APPROVAL",
    })
    .returning({ id: dbm.report.id });

  const verdictId = randomUUID();
  const payload = `drafted comment ${seq}\n\n<!-- bountydesk-delivery:${verdictId} -->`;
  const contentHash = computeContentHash(payload);
  await dbm.db.insert(dbm.verdict).values({
    id: verdictId,
    reportId: reportRow.id,
    outcome: "ANALYSIS_ONLY",
    summary: "summary",
    payload,
    contentHash,
  });
  await dbm.db.insert(dbm.agentSession).values({
    reportId: reportRow.id,
    capabilityToken: `cap-mobile-${seq}`,
    sessionId: `sess-mobile-${seq}`,
    pendingThreadId: `thread-${seq}`,
    pendingToolCallId: `call-${seq}`,
    pendingVerdictId: verdictId,
    pendingApprovedContentHash: contentHash,
  });
  return { reportId: reportRow.id, verdictId, contentHash, payload };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) =>
  new Request("http://app.test/api/mobile/v1/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (path = "") => new Request(`http://app.test/api/mobile/v1/x${path}`);

async function decisions(verdictId: string) {
  return dbm.db
    .select()
    .from(dbm.approvalDecision)
    .where(dbm.eq(dbm.approvalDecision.verdictId, verdictId));
}

async function stateOf(reportId: string) {
  const [row] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportId));
  return row?.state;
}

test("every route answers 401 without a token", async () => {
  asAnonymous();
  const { reportId } = await seedPendingReport();
  const hash = "a".repeat(64);
  const body = { verdictId: randomUUID(), contentHash: hash, reason: "no" };

  const responses = [
    await me.GET(),
    await home.GET(),
    await queue.GET(get()),
    await reports.GET(get()),
    await reportCase.GET(get(), ctx(reportId)),
    await chat.GET(get(), ctx(reportId)),
    await chat.POST(post({ clientRequestId: "c1", body: "hi" }), ctx(reportId)),
    await approve.POST(post(body), ctx(reportId)),
    await deny.POST(post(body), ctx(reportId)),
    await connections.GET(),
    await integrations.GET(),
  ];
  for (const response of responses) assert.equal(response.status, 401);
});

test("a signed-in account that is not allowlisted gets 403 everywhere but /me", async () => {
  asOutsider();
  const { reportId } = await seedPendingReport();
  const body = { verdictId: randomUUID(), contentHash: "a".repeat(64) };

  for (const response of [
    await home.GET(),
    await queue.GET(get()),
    await reports.GET(get()),
    await reportCase.GET(get(), ctx(reportId)),
    await chat.GET(get(), ctx(reportId)),
    await approve.POST(post(body), ctx(reportId)),
    await connections.GET(),
    await integrations.GET(),
  ]) {
    assert.equal(response.status, 403);
  }

  const response = await me.GET();
  assert.equal(response.status, 200);
  const identity = await response.json();
  assert.equal(identity.allowlisted, false);
  assert.equal(identity.email, "outsider@example.test");
});

test("/me reports an allowlisted reviewer with their role", async () => {
  const response = await me.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { allowlisted: true, ...reviewer });
});

test("a read-only reviewer can read but is refused approve, deny and chat", async () => {
  asReadOnly();
  const { reportId, verdictId, contentHash } = await seedPendingReport();

  assert.equal((await reportCase.GET(get(), ctx(reportId))).status, 200);

  const body = { verdictId, contentHash, reason: "no" };
  assert.equal((await approve.POST(post(body), ctx(reportId))).status, 403);
  assert.equal((await deny.POST(post(body), ctx(reportId))).status, 403);
  assert.equal((await chat.POST(post({ clientRequestId: "c1", body: "hi" }), ctx(reportId))).status, 403);
  assert.equal((await decisions(verdictId)).length, 0);
});

test("approve refuses a content hash that is not the verdict's, and records nothing", async () => {
  const { reportId, verdictId, contentHash } = await seedPendingReport();
  // A hash of the text the app thinks it showed, which is not the text this verdict delivers.
  const wrong = computeContentHash("some other comment");
  assert.notEqual(wrong, contentHash);

  const response = await approve.POST(post({ verdictId, contentHash: wrong }), ctx(reportId));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "content_hash_mismatch");

  assert.equal((await decisions(verdictId)).length, 0);
  assert.equal(await stateOf(reportId), "AWAITING_APPROVAL");
});

test("deny refuses a mismatched hash too, so a stale screen cannot close the report", async () => {
  const { reportId, verdictId } = await seedPendingReport();

  const response = await deny.POST(
    post({ verdictId, contentHash: computeContentHash("stale"), reason: "not a bug" }),
    ctx(reportId),
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "content_hash_mismatch");
  assert.equal((await decisions(verdictId)).length, 0);
  assert.equal(await stateOf(reportId), "AWAITING_APPROVAL");
});

test("approve with the matching hash records the decision under the reviewer's login", async () => {
  const { reportId, verdictId, contentHash } = await seedPendingReport();

  const response = await approve.POST(post({ verdictId, contentHash }), ctx(reportId));
  assert.equal(response.status, 200);

  const rows = await decisions(verdictId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, "APPROVED");
  assert.equal(rows[0].reviewer, "alice");
  assert.equal(rows[0].payloadHash, contentHash);
});

test("deny with the matching hash closes the report and stores the reason as the note", async () => {
  const { reportId, verdictId, contentHash } = await seedPendingReport();

  const response = await deny.POST(post({ verdictId, contentHash, reason: "not a bug" }), ctx(reportId));
  assert.equal(response.status, 200);

  const rows = await decisions(verdictId);
  assert.equal(rows[0].decision, "DENIED");
  assert.equal(rows[0].note, "not a bug");
  assert.equal(await stateOf(reportId), "DENIED");
});

test("approve and deny reject malformed bodies before touching the gate", async () => {
  const { reportId, verdictId, contentHash } = await seedPendingReport();

  assert.equal((await approve.POST(post({ verdictId }), ctx(reportId))).status, 400);
  assert.equal((await approve.POST(post({ verdictId, contentHash: "short" }), ctx(reportId))).status, 400);
  assert.equal((await deny.POST(post({ verdictId, contentHash }), ctx(reportId))).status, 400);
  assert.equal((await approve.POST(post({ verdictId, contentHash }), ctx("not-a-uuid"))).status, 404);
  assert.equal((await decisions(verdictId)).length, 0);
});

test("the case file carries the exact drafted text and the hash the app must send back", async () => {
  const { reportId, verdictId, contentHash, payload } = await seedPendingReport();

  const response = await reportCase.GET(get(), ctx(reportId));
  assert.equal(response.status, 200);
  const file = await response.json();
  assert.equal(file.id, reportId);
  assert.equal(file.awaitingVerdictId, verdictId);
  assert.equal(file.verdict.payload, payload);
  assert.equal(file.verdict.contentHash, contentHash);
  assert.equal(computeContentHash(file.verdict.payload), file.verdict.contentHash);
  assert.ok(Array.isArray(file.events) && Array.isArray(file.toolCalls) && Array.isArray(file.appeals));

  assert.equal((await reportCase.GET(get(), ctx(randomUUID()))).status, 404);
});

test("list routes return the web read models, paged", async () => {
  const { reportId } = await seedPendingReport();

  const homeBody = await (await home.GET()).json();
  assert.ok(homeBody.needsYou >= 1);
  assert.equal(homeBody.needsYou, homeBody.awaiting);
  assert.ok(homeBody.phases.some((phase: { key: string }) => phase.key === "awaiting-approval"));

  const board = await (await queue.GET(get("?phase=awaiting-approval&limit=1"))).json();
  assert.equal(board.columns.length, 1);
  assert.equal(board.columns[0].cards.length, 1);
  assert.equal((await queue.GET(get("?phase=nope"))).status, 400);
  assert.equal((await queue.GET(get("?limit=0"))).status, 400);

  const found = await (await reports.GET(get(`?state=AWAITING_APPROVAL&q=${encodeURIComponent("mobile report")}`))).json();
  assert.ok(found.reports.some((row: { id: string }) => row.id === reportId));
  assert.equal((await reports.GET(get("?state=BOGUS"))).status, 400);
  const none = await (await reports.GET(get("?q=zzz-no-such-report"))).json();
  assert.deepEqual(none.reports, []);

  const rows = await (await integrations.GET()).json();
  assert.deepEqual(rows.map((row: { id: string }) => row.id), ["github", "email", "upload"]);
  assert.ok(Array.isArray(await (await connections.GET()).json()));
});
