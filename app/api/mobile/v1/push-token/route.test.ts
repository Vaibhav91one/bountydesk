import assert from "node:assert/strict";
import test, { after, before, beforeEach, mock } from "node:test";

type Session = { login: string; email: string; avatarUrl: string | null; role: "owner" | "member" | "read_only" };
type Caller = { userId: string | null; session: Session | null };
let caller: Caller = { userId: null, session: null };

mock.module("@/lib/auth/dal", {
  namedExports: {
    signedInUserId: async () => caller.userId,
    currentSession: async () => caller.session,
    clerkProfile: async () => ({ login: "outsider", email: "outsider@example.test", avatarUrl: null }),
  },
});

mock.module("@/lib/auth/reviewers", {
  namedExports: {
    isReviewerWriter: async () => caller.session !== null && caller.session.role !== "read_only",
    isReviewerEmail: async () => caller.session !== null,
    canManageReviewers: () => true,
    listReviewers: async () => [],
    startVerification: async () => ({ status: "code_sent" as const, code: "123456" }),
    verifyCode: async () => ({ ok: true as const }),
  },
});

const reviewer: Session = { login: "alice", email: "alice@bountydesk.test", avatarUrl: null, role: "member" };
const asReviewer = () => (caller = { userId: "user_1", session: reviewer });
const asAnonymous = () => (caller = { userId: null, session: null });

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let route: typeof import("./route");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("push-token-route");
  dbm = await import("@/lib/db");
  route = await import("./route");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

beforeEach(async () => {
  await dbm.db.delete(dbm.devicePushToken).execute();
});

const post = (body: unknown) =>
  new Request("http://app.test/api/mobile/v1/push-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const del = (body: unknown) =>
  new Request("http://app.test/api/mobile/v1/push-token", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const VALID_TOKEN = "ExponentPushToken[abcdef0123456789_-]";

test("a valid token upserts", async () => {
  asReviewer();
  const res = await route.POST(post({ token: VALID_TOKEN, platform: "ios" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const [row] = await dbm.db
    .select({ token: dbm.devicePushToken.token, email: dbm.devicePushToken.reviewerEmail, platform: dbm.devicePushToken.platform })
    .from(dbm.devicePushToken)
    .where(dbm.eq(dbm.devicePushToken.token, VALID_TOKEN));
  assert.equal(row.email, "alice@bountydesk.test");
  assert.equal(row.platform, "ios");

  // Upsert again with a different platform and email.
  caller = { userId: "user_2", session: { ...reviewer, email: "other@bountydesk.test" } };
  const res2 = await route.POST(post({ token: VALID_TOKEN, platform: "android" }));
  assert.equal(res2.status, 200);

  const [row2] = await dbm.db
    .select({ email: dbm.devicePushToken.reviewerEmail, platform: dbm.devicePushToken.platform })
    .from(dbm.devicePushToken)
    .where(dbm.eq(dbm.devicePushToken.token, VALID_TOKEN));
  assert.equal(row2.email, "other@bountydesk.test");
  assert.equal(row2.platform, "android");
});

test("a malformed token gives 400", async () => {
  asReviewer();
  const res = await route.POST(post({ token: "not-a-real-token", platform: "ios" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid token");
});

test("a token over 200 chars gives 400", async () => {
  asReviewer();
  const longSuffix = "x".repeat(200);
  const res = await route.POST(post({ token: `ExponentPushToken[${longSuffix}]`, platform: "ios" }));
  assert.equal(res.status, 400);
});

test("an invalid platform gives 400", async () => {
  asReviewer();
  const res = await route.POST(post({ token: VALID_TOKEN, platform: "web" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid platform");
});

test("unauthenticated gives the gate response", async () => {
  asAnonymous();
  const res = await route.POST(post({ token: VALID_TOKEN, platform: "ios" }));
  assert.equal(res.status, 401);
});

test("DELETE revokes only your own token", async () => {
  asReviewer();
  // Seed a token for alice.
  await dbm.db.insert(dbm.devicePushToken).values({
    token: VALID_TOKEN,
    reviewerEmail: "alice@bountydesk.test",
    platform: "ios",
  });

  // alice can revoke her own.
  const res = await route.DELETE(del({ token: VALID_TOKEN }));
  assert.equal(res.status, 204);
  const [row] = await dbm.db
    .select({ revokedAt: dbm.devicePushToken.revokedAt })
    .from(dbm.devicePushToken)
    .where(dbm.eq(dbm.devicePushToken.token, VALID_TOKEN));
  assert.ok(row.revokedAt !== null);

  // Another reviewer cannot revoke alice's token.
  caller = { userId: "user_2", session: { ...reviewer, email: "bob@bountydesk.test" } };
  const res2 = await route.DELETE(del({ token: VALID_TOKEN }));
  assert.equal(res2.status, 404);
});

test("DELETE with no token gives 400", async () => {
  asReviewer();
  const res = await route.DELETE(del({}));
  assert.equal(res.status, 400);
});
