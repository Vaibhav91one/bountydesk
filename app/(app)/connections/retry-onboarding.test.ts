import assert from "node:assert/strict";
import test, { after, before } from "node:test";

const REVIEWER_EMAIL = "reviewer@bountydesk.test";
process.env.REVIEWER_EMAILS = REVIEWER_EMAIL;

// Imported only after createSchema: ./retry-onboarding loads @/lib/db, and loading it first would
// point every fixture below at the real database instead of the disposable schema.
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let mod: typeof import("./retry-onboarding");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("retry_onboarding");
  dbm = await import("@/lib/db");
  mod = await import("./retry-onboarding");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

type Grant = "live" | "inactive" | "archived" | "suspended" | "deleted";

let seq = 0;
async function seed(state: string, grant: Grant = "live"): Promise<number> {
  seq += 1;
  const repoId = 700_000 + seq;
  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({
      installationId: 810_000 + seq,
      accountLogin: `own-${seq}`,
      accountId: 910_000 + seq,
      suspendedAt: grant === "suspended" ? new Date() : null,
      deletedAt: grant === "deleted" ? new Date() : null,
    })
    .returning({ id: dbm.githubInstallation.id });
  await dbm.db.insert(dbm.connectedRepository).values({
    installationId: installation.id,
    repoId,
    fullName: `acme/current-${seq}`,
    active: grant !== "inactive",
    archivedAt: grant === "archived" ? new Date() : null,
  });
  // A stale name and a foreign clone URL on the onboarding row, so a retry that read either of
  // them instead of connected_repository would show up in the assertions.
  await dbm.db.insert(dbm.targetOnboarding).values({
    repoId,
    repoFullName: `acme/old-${seq}`,
    sourceRef: "https://evil.example/elsewhere.git",
    state,
    attempts: 8,
    lastError: "build failed",
  });
  return repoId;
}

function rowOf(repoId: number) {
  return dbm.db
    .select({
      state: dbm.targetOnboarding.state,
      repoFullName: dbm.targetOnboarding.repoFullName,
      sourceRef: dbm.targetOnboarding.sourceRef,
      attempts: dbm.targetOnboarding.attempts,
      lastError: dbm.targetOnboarding.lastError,
    })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId))
    .then((rows) => rows[0]);
}

const reviewer = { login: "octocat", email: REVIEWER_EMAIL, avatarUrl: null };

test("a reviewer requeues a FAILED row from the start, with the name and clone URL from the grant", async () => {
  const repoId = await seed("FAILED");
  const result = await mod.retryOnboardingRequest(reviewer, String(repoId));
  assert.deepEqual(result, { ok: true });

  const row = await rowOf(repoId);
  assert.equal(row.state, "PENDING_PLAN");
  assert.equal(row.repoFullName, `acme/current-${seq}`);
  assert.equal(row.sourceRef, `https://github.com/acme/current-${seq}.git`);
  assert.equal(row.attempts, 0);
  assert.equal(row.lastError, null);
});

test("a non-reviewer or no session changes nothing", async () => {
  const repoId = await seed("FAILED");
  for (const session of [null, { login: "stranger", email: "stranger@example.com", avatarUrl: null }]) {
    const result = await mod.retryOnboardingRequest(session, repoId);
    assert.equal(result.ok, false);
  }
  assert.equal((await rowOf(repoId)).state, "FAILED");
});

test("only a FAILED row is retried", async () => {
  for (const state of ["UNSUPPORTED", "PENDING_BUILD", "AWAITING_APPROVAL", "APPROVED", "CONFIGURED"]) {
    const repoId = await seed(state);
    const result = await mod.retryOnboardingRequest(reviewer, repoId);
    assert.equal(result.ok, false, state);
    const row = await rowOf(repoId);
    assert.equal(row.state, state);
    assert.equal(row.sourceRef, "https://evil.example/elsewhere.git");
  }
});

test("a repository with no onboarding row is refused", async () => {
  seq += 1;
  const result = await mod.retryOnboardingRequest(reviewer, 700_000 + seq);
  assert.equal(result.ok, false);
});

test("a grant that is no longer live is refused", async () => {
  for (const grant of ["inactive", "archived", "suspended", "deleted"] as const) {
    const repoId = await seed("FAILED", grant);
    const result = await mod.retryOnboardingRequest(reviewer, repoId);
    assert.equal(result.ok, false, grant);
    assert.equal((await rowOf(repoId)).state, "FAILED", grant);
  }
});

test("a private repository is retried only once the installation holds Contents: read", async () => {
  const repoId = await seed("FAILED");
  const [repo] = await dbm.db
    .update(dbm.connectedRepository)
    .set({ isPrivate: true })
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId))
    .returning({ installationId: dbm.connectedRepository.installationId });

  const refused = await mod.retryOnboardingRequest(reviewer, repoId);
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /Contents: read/);
  assert.equal((await rowOf(repoId)).state, "FAILED");

  await dbm.db
    .update(dbm.githubInstallation)
    .set({ contentsPermission: "read" })
    .where(dbm.eq(dbm.githubInstallation.id, repo.installationId));
  assert.deepEqual(await mod.retryOnboardingRequest(reviewer, repoId), { ok: true });
  assert.equal((await rowOf(repoId)).state, "PENDING_PLAN");
});

test("a malformed repo id is refused before any lookup", async () => {
  for (const raw of [null, "", "abc", "-1", "0", "1.5", "9007199254740993"]) {
    const result = await mod.retryOnboardingRequest(reviewer, raw);
    assert.deepEqual(result, { ok: false, error: "That repository id is not valid." }, String(raw));
  }
});
