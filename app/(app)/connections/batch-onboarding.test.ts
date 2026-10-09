import assert from "node:assert/strict";
import test, { after, before } from "node:test";

const REVIEWER_EMAIL = "reviewer@bountydesk.test";
process.env.REVIEWER_EMAILS = REVIEWER_EMAIL;

// Imported only after createSchema, or the fixtures would land in the real database.
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let mod: typeof import("./batch-onboarding");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("batch_onboarding");
  dbm = await import("@/lib/db");
  mod = await import("./batch-onboarding");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;
async function seedRepo(active = true): Promise<number> {
  seq += 1;
  const repoId = 600_000 + seq;
  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId: 710_000 + seq, accountLogin: `own-${seq}`, accountId: 910_000 + seq })
    .returning({ id: dbm.githubInstallation.id });
  await dbm.db.insert(dbm.connectedRepository).values({
    installationId: installation.id,
    repoId,
    fullName: `acme/repo-${seq}`,
    active,
  });
  return repoId;
}

const rows = (repoId: number) =>
  dbm.db.select().from(dbm.targetOnboarding).where(dbm.eq(dbm.targetOnboarding.repoId, repoId));

const reviewer = { login: "octocat", email: REVIEWER_EMAIL, avatarUrl: null, role: "member" as const };

test("N repos enqueue N distinct rows, none past PENDING_PLAN", async () => {
  const ids = [await seedRepo(), await seedRepo(), await seedRepo()];
  const result = await mod.batchOnboardRequest(reviewer, ids);
  assert.ok(result.ok);
  assert.ok(result.ok && result.results.every((r) => r.ok));
  for (const id of ids) {
    const found = await rows(id);
    assert.equal(found.length, 1);
    // Only the worker moves a row on, and it stops at AWAITING_APPROVAL for a human.
    assert.equal(found[0].state, "PENDING_PLAN");
    assert.equal(found[0].approvedBy, null);
  }
});

test("enqueuing the same repo twice stays idempotent", async () => {
  const id = await seedRepo();
  await mod.batchOnboardRequest(reviewer, [id]);
  await dbm.db
    .update(dbm.targetOnboarding)
    .set({ state: "AWAITING_APPROVAL" })
    .where(dbm.eq(dbm.targetOnboarding.repoId, id));
  await mod.batchOnboardRequest(reviewer, [id]);
  const found = await rows(id);
  assert.equal(found.length, 1);
  assert.equal(found[0].state, "AWAITING_APPROVAL");
});

test("an invalid, inactive or duplicate id is skipped and reported", async () => {
  const good = await seedRepo();
  const inactive = await seedRepo(false);
  const result = await mod.batchOnboardRequest(reviewer, [good, inactive, 999_999_999, "abc", good]);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(
    result.results.map((r) => r.ok),
    [true, false, false, false, false],
  );
  assert.equal((await rows(good)).length, 1);
  assert.equal((await rows(inactive)).length, 0);
});

test("a non-reviewer or an empty batch changes nothing", async () => {
  const id = await seedRepo();
  const stranger = { login: "x", email: "stranger@example.com", avatarUrl: null, role: "member" as const };
  assert.equal((await mod.batchOnboardRequest(stranger, [id])).ok, false);
  assert.equal((await mod.batchOnboardRequest(null, [id])).ok, false);
  assert.equal((await mod.batchOnboardRequest(reviewer, [])).ok, false);
  assert.equal((await rows(id)).length, 0);
});
