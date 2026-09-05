import assert from "node:assert/strict";
import test, { after, before } from "node:test";

const REVIEWER_ID = 4242;
process.env.REVIEWER_GITHUB_IDS = String(REVIEWER_ID);

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let mod: typeof import("./approve-request");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("target_onboarding_approve");
  dbm = await import("@/lib/db");
  mod = await import("./approve-request");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;
async function seed(state: string): Promise<number> {
  seq += 1;
  const repoId = 600_000 + seq;
  await dbm.db.insert(dbm.targetOnboarding).values({
    repoId,
    repoFullName: `acme/repo-${seq}`,
    sourceRef: `https://x/repo-${seq}.git`,
    state,
  });
  return repoId;
}

function stateOf(repoId: number) {
  return dbm.db
    .select({ state: dbm.targetOnboarding.state, approvedBy: dbm.targetOnboarding.approvedBy })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId))
    .then((rows) => rows[0]);
}

const reviewer = { userId: REVIEWER_ID, login: "octocat", expiresAt: Date.now() + 60_000 };

test("a reviewer moves an awaiting row to APPROVED and is recorded", async () => {
  const repoId = await seed("AWAITING_APPROVAL");
  const result = await mod.approveOnboardingRequest(reviewer, repoId);
  assert.equal(result.ok, true);
  const row = await stateOf(repoId);
  assert.equal(row.state, "APPROVED");
  assert.equal(row.approvedBy, "octocat");
});

test("a non-reviewer changes nothing", async () => {
  const repoId = await seed("AWAITING_APPROVAL");
  const result = await mod.approveOnboardingRequest(
    { userId: 9999, login: "stranger", expiresAt: Date.now() + 60_000 },
    repoId,
  );
  assert.equal(result.ok, false);
  assert.equal((await stateOf(repoId)).state, "AWAITING_APPROVAL");
});

test("a null session is refused", async () => {
  const repoId = await seed("AWAITING_APPROVAL");
  const result = await mod.approveOnboardingRequest(null, repoId);
  assert.equal(result.ok, false);
  assert.equal((await stateOf(repoId)).state, "AWAITING_APPROVAL");
});

test("a row not awaiting approval is left untouched", async () => {
  const repoId = await seed("PENDING_BUILD");
  const result = await mod.approveOnboardingRequest(reviewer, repoId);
  assert.equal(result.ok, false);
  assert.equal((await stateOf(repoId)).state, "PENDING_BUILD");
});
