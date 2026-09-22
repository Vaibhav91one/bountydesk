import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The allowlist is two layers: owners in REVIEWER_EMAILS, members in the `reviewer` table, and a
 * member counts only once they have entered the one-time code. These run against a real schema
 * because the member half is a database and the guarantees worth proving are the database's: an
 * owner short-circuits without a row, a pending member authorizes nothing, a correct code within
 * its window verifies, and a wrong or expired code is refused.
 */
const OWNER = "owner@bountydesk.test";
process.env.REVIEWER_EMAILS = OWNER;

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let mod: typeof import("./reviewers");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("reviewers");
  dbm = await import("@/lib/db");
  mod = await import("./reviewers");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

async function code(email: string): Promise<string> {
  const result = await mod.startVerification(email, OWNER);
  assert.equal(result.status, "code_sent");
  return (result as { status: "code_sent"; code: string }).code;
}

test("owners come from the env and are authorized without any row", async () => {
  process.env.REVIEWER_EMAILS = " Owner@Bountydesk.test ";
  assert.equal(mod.isOwnerEmail("OWNER@bountydesk.test"), true);
  assert.equal(await mod.isReviewerEmail("Owner@bountydesk.test"), true);
  assert.equal(await mod.isReviewerEmail("stranger@example.com"), false);
  process.env.REVIEWER_EMAILS = OWNER;
});

test("a pending member authorizes nothing until the code is entered", async () => {
  process.env.REVIEWER_EMAILS = OWNER;
  const member = "pending@example.com";
  const sent = await code("Pending@Example.com");
  assert.match(sent, /^\d{6}$/);
  assert.equal(await mod.isReviewerEmail(member), false, "pending is not authorized");

  const ok = await mod.verifyCode(member, sent);
  assert.equal(ok.ok, true);
  assert.equal(await mod.isReviewerEmail(member), true, "verified is authorized");
});

test("a wrong code spends an attempt; the right code still works after", async () => {
  process.env.REVIEWER_EMAILS = OWNER;
  const member = "attempts@example.com";
  const sent = await code(member);
  const bad = await mod.verifyCode(member, sent === "000000" ? "111111" : "000000");
  assert.equal(bad.ok, false);
  assert.equal(await mod.isReviewerEmail(member), false);
  const good = await mod.verifyCode(member, sent);
  assert.equal(good.ok, true);
});

test("too many wrong attempts locks the code until a new one is sent", async () => {
  process.env.REVIEWER_EMAILS = OWNER;
  const member = "locked@example.com";
  const sent = await code(member);
  const wrong = sent === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i += 1) await mod.verifyCode(member, wrong);
  const afterCap = await mod.verifyCode(member, sent);
  assert.equal(afterCap.ok, false);
  assert.match((afterCap as { ok: false; error: string }).error, /Too many attempts/);

  // A fresh code resets the attempt count.
  const next = await code(member);
  assert.equal((await mod.verifyCode(member, next)).ok, true);
});

test("an expired code is refused", async () => {
  process.env.REVIEWER_EMAILS = OWNER;
  const member = "expired@example.com";
  const sent = await code(member);
  await dbm.db
    .update(dbm.reviewer)
    .set({ codeExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.reviewer.email, member));
  const result = await mod.verifyCode(member, sent);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; error: string }).error, /expired/);
});

test("resending invalidates the previous code", async () => {
  process.env.REVIEWER_EMAILS = OWNER;
  const member = "resend@example.com";
  const first = await code(member);
  const second = await code(member);
  assert.notEqual(first, second);
  assert.equal((await mod.verifyCode(member, first)).ok, false, "the old code no longer works");
  assert.equal((await mod.verifyCode(member, second)).ok, true);
});

test("an owner cannot be added, and an already-verified address is a no-op", async () => {
  process.env.REVIEWER_EMAILS = OWNER;
  await assert.rejects(mod.startVerification(OWNER, OWNER), /already an owner/);

  const member = "verified@example.com";
  await mod.verifyCode(member, await code(member));
  assert.deepEqual(await mod.startVerification(member, OWNER), { status: "already_verified" });
});

test("removing a member revokes access; an owner cannot be removed here", async () => {
  process.env.REVIEWER_EMAILS = OWNER;
  const member = "removable@example.com";
  await mod.verifyCode(member, await code(member));
  assert.equal(await mod.isReviewerEmail(member), true);
  await mod.removeReviewer("REMOVABLE@example.com");
  assert.equal(await mod.isReviewerEmail(member), false);
  await assert.rejects(mod.removeReviewer(OWNER), /cannot be removed/);
});

test("listReviewers marks role and verification", async () => {
  process.env.REVIEWER_EMAILS = OWNER;
  const verified = "listed-verified@example.com";
  const pending = "listed-pending@example.com";
  await mod.verifyCode(verified, await code(verified));
  await code(pending);
  const list = await mod.listReviewers();
  assert.equal(list[0].role, "owner");
  assert.equal(list[0].verified, true);
  assert.equal(list.find((r) => r.email === verified)?.verified, true);
  assert.equal(list.find((r) => r.email === pending)?.verified, false);
});

test("only owners may manage; the GitHub id allowlist is unchanged", () => {
  process.env.REVIEWER_EMAILS = OWNER;
  assert.equal(mod.canManageReviewers(OWNER), true);
  assert.equal(mod.canManageReviewers("pending@example.com"), false);

  process.env.REVIEWER_GITHUB_IDS = " 42 , 583231 ";
  assert.deepEqual([...mod.reviewerIds()].sort((a, b) => a - b), [42, 583231]);
  assert.equal(mod.isReviewer(42), true);
  assert.equal(mod.isReviewer(43), false);
});
