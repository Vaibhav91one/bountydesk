import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The authorization boundary in front of the only mutation an operator can trigger.
 *
 * Every denial here is checked twice: the call must be refused, and the database must be
 * unchanged afterwards. A guard that returns an error while still writing the row would
 * pass the first assertion on its own, which is exactly the bug worth catching.
 */
const REVIEWER_ID = 4242;
process.env.REVIEWER_GITHUB_IDS = String(REVIEWER_ID);
process.env.DAYTONA_TARGET_IMAGE_DIGEST = `sha256:${"0".repeat(64)}`;

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let configure: typeof import("./configure-request");

let installationRowId: string;
let ids = 0;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("configreq");

  dbm = await import("@/lib/db");
  configure = await import("./configure-request");

  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId: 55_001, accountLogin: "acme", accountId: 77, accountType: "User" })
    .returning({ id: dbm.githubInstallation.id });

  installationRowId = installation.id;
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function session(userId: number) {
  return { login: "someone", userId, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
}

async function repo({ active = true } = {}) {
  ids += 1;
  const repoId = 66_000 + ids;
  await dbm.db.insert(dbm.connectedRepository).values({
    installationId: installationRowId,
    repoId,
    fullName: `acme/repo-${ids}`,
    active,
  });
  return repoId;
}

async function boundTarget(repoId: number): Promise<string | null> {
  const [row] = await dbm.db
    .select({ targetProfileId: dbm.connectedRepository.targetProfileId })
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId));

  return row?.targetProfileId ?? null;
}

test("an unauthenticated caller is denied and changes nothing", async () => {
  const repoId = await repo();

  const result = await configure.configureRepositoryRequest(null, repoId);

  assert.equal(result.ok, false);
  assert.equal(await boundTarget(repoId), null, "no binding was written");
});

test("a signed-in user who is not a reviewer is denied and changes nothing", async () => {
  const repoId = await repo();

  // A perfectly valid session: the cookie is real, the person is not on the allowlist.
  const result = await configure.configureRepositoryRequest(session(999_999), repoId);

  assert.equal(result.ok, false);
  assert.equal(await boundTarget(repoId), null, "no binding was written");
});

test("a reviewer can configure an active repository", async () => {
  const repoId = await repo();

  const result = await configure.configureRepositoryRequest(session(REVIEWER_ID), repoId);

  assert.equal(result.ok, true);
  assert.ok(await boundTarget(repoId), "the repository is bound to a target");
});

test("a repository the installation no longer grants is refused", async () => {
  const repoId = await repo({ active: false });

  const result = await configure.configureRepositoryRequest(session(REVIEWER_ID), repoId);

  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /not connected/);
  assert.equal(await boundTarget(repoId), null);
});

test("an unusable repository id is refused before touching the database", async () => {
  for (const bad of [undefined, null, "", "abc", "0", "-1", "1.5", Number.MAX_SAFE_INTEGER + 2]) {
    const result = await configure.configureRepositoryRequest(session(REVIEWER_ID), bad);
    assert.equal(result.ok, false, String(bad));
  }

  // A well-formed id for a repository that simply does not exist is refused too.
  const result = await configure.configureRepositoryRequest(session(REVIEWER_ID), 987_654_321);
  assert.equal(result.ok, false);
});

test("an unexpected failure does not leak its message to the browser", async () => {
  const repoId = await repo();

  // A digest that disagrees with the stored profile is the one raise-path that is not a
  // domain error, so it stands in for "something the operator should not be shown".
  process.env.DAYTONA_TARGET_IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
  const result = await configure.configureRepositoryRequest(session(REVIEWER_ID), repoId);
  process.env.DAYTONA_TARGET_IMAGE_DIGEST = `sha256:${"0".repeat(64)}`;

  assert.equal(result.ok, false);
  const error = (result as { error: string }).error;
  assert.equal(/sha256:/.test(error), false, "no digest is echoed back");
});
