import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The allowlist is two layers: owners in REVIEWER_EMAILS, members in the `reviewer` table. These
 * run against a real schema because the member half is a database, and the guarantees worth
 * proving (an owner short-circuits without a row, a removed member stops being authorized, an
 * owner cannot be removed here) are the database's.
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

test("owners come from the env, case-insensitively, and short-circuit the database", async () => {
  process.env.REVIEWER_EMAILS = " Owner@Bountydesk.test , second@bountydesk.test ";
  assert.deepEqual([...mod.reviewerEmails()].sort(), ["owner@bountydesk.test", "second@bountydesk.test"]);
  assert.equal(mod.isOwnerEmail("OWNER@bountydesk.test"), true);
  assert.equal(mod.isOwnerEmail("stranger@example.com"), false);
  assert.equal(await mod.isReviewerEmail("Owner@bountydesk.test"), true);
  assert.equal(await mod.isReviewerEmail(null), false);
  process.env.REVIEWER_EMAILS = OWNER;
});

test("a member added to the table is authorized; a stranger is not", async () => {
  process.env.REVIEWER_EMAILS = OWNER;
  const member = "member1@example.com";
  assert.equal(await mod.isReviewerEmail(member), false);
  await mod.addReviewer("Member1@Example.com", OWNER);
  assert.equal(await mod.isReviewerEmail(member), true);
  assert.equal(await mod.isReviewerEmail("outsider@example.com"), false);
});

test("adding is idempotent and a no-op for an address that is already an owner", async () => {
  process.env.REVIEWER_EMAILS = OWNER;
  await mod.addReviewer("member2@example.com", OWNER);
  await mod.addReviewer("member2@example.com", OWNER);
  await mod.addReviewer(OWNER, OWNER);
  const members = (await mod.listReviewers()).filter((r) => r.role === "member").map((r) => r.email);
  assert.equal(members.filter((e) => e === "member2@example.com").length, 1);
  assert.ok(!members.includes(OWNER), "an owner is never stored as a member");
});

test("a malformed address is rejected", async () => {
  process.env.REVIEWER_EMAILS = OWNER;
  await assert.rejects(mod.addReviewer("not-an-email", OWNER), /valid email/);
});

test("removing a member revokes access; an owner cannot be removed here", async () => {
  process.env.REVIEWER_EMAILS = OWNER;
  const member = "member3@example.com";
  await mod.addReviewer(member, OWNER);
  assert.equal(await mod.isReviewerEmail(member), true);
  await mod.removeReviewer("MEMBER3@example.com");
  assert.equal(await mod.isReviewerEmail(member), false);
  await assert.rejects(mod.removeReviewer(OWNER), /cannot be removed/);
});

test("listReviewers puts owners first, then members, and marks the role", async () => {
  process.env.REVIEWER_EMAILS = OWNER;
  await mod.addReviewer("zzz-member@example.com", OWNER);
  const list = await mod.listReviewers();
  assert.equal(list[0].role, "owner");
  assert.equal(list[0].email, OWNER);
  const member = list.find((r) => r.email === "zzz-member@example.com");
  assert.equal(member?.role, "member");
  assert.equal(member?.addedByEmail, OWNER);
});

test("only owners may manage the list", () => {
  process.env.REVIEWER_EMAILS = OWNER;
  assert.equal(mod.canManageReviewers(OWNER), true);
  assert.equal(mod.canManageReviewers("member1@example.com"), false);
});

test("the GitHub-webhook allowlist stays a set of numeric ids, unchanged", () => {
  process.env.REVIEWER_GITHUB_IDS = " 42 , 583231 ";
  assert.deepEqual([...mod.reviewerIds()].sort((a, b) => a - b), [42, 583231]);
  assert.equal(mod.isReviewer(42), true);
  assert.equal(mod.isReviewer(43), false);
});
