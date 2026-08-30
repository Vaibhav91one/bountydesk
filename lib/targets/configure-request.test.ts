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
process.env.DAYTONA_TARGET_SNAPSHOT_ID = "snapshot-test";

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

test("rotating before anything is configured is refused", async () => {
  // Must run before any configure call creates the shared target profile row.
  const repoId = await repo();

  const result = await configure.rotateRepositoryTargetRequest(session(REVIEWER_ID), repoId);

  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /no existing target profile/);
});

test("a reviewer can configure an active repository", async () => {
  const repoId = await repo();

  const result = await configure.configureRepositoryRequest(session(REVIEWER_ID), repoId);

  assert.equal(result.ok, true);
  assert.ok(await boundTarget(repoId), "the repository is bound to a target");
});

test("a reviewer can configure an explicitly selected registered target profile", async () => {
  const repoId = await repo();

  const result = await configure.configureRepositoryRequest(
    session(REVIEWER_ID),
    repoId,
    "juice-shop-v17.3.0",
  );

  assert.equal(result.ok, true);
  const targetProfileId = await boundTarget(repoId);
  assert.ok(targetProfileId, "the repository is bound to the selected target");
  const [row] = await dbm.db
    .select({ name: dbm.targetProfile.name })
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.id, targetProfileId));
  assert.equal(row.name, "juice-shop-v17.3.0");
});

test("an unknown selected target profile is refused before touching the database", async () => {
  const repoId = await repo();

  const result = await configure.configureRepositoryRequest(
    session(REVIEWER_ID),
    repoId,
    "unknown-target",
  );

  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /not registered/);
  assert.equal(await boundTarget(repoId), null);
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

test("a missing image digest or snapshot id fails closed rather than falling back", async () => {
  const repoId = await repo();
  const digest = process.env.DAYTONA_TARGET_IMAGE_DIGEST;
  const snapshotId = process.env.DAYTONA_TARGET_SNAPSHOT_ID;

  for (const [key, value] of [
    ["DAYTONA_TARGET_IMAGE_DIGEST", digest],
    ["DAYTONA_TARGET_SNAPSHOT_ID", snapshotId],
  ] as const) {
    delete process.env[key];
    const result = await configure.configureRepositoryRequest(session(REVIEWER_ID), repoId);
    process.env[key] = value;

    assert.equal(result.ok, false, key);
    assert.equal(await boundTarget(repoId), null, `${key} missing must not bind a target`);
  }
});

test("the env.example placeholders are nonempty but still refused", async () => {
  const repoId = await repo();
  const digest = process.env.DAYTONA_TARGET_IMAGE_DIGEST;
  const snapshotId = process.env.DAYTONA_TARGET_SNAPSHOT_ID;

  process.env.DAYTONA_TARGET_IMAGE_DIGEST = "<sha256-of-connected-fork-build>";
  process.env.DAYTONA_TARGET_SNAPSHOT_ID = "<immutable-daytona-snapshot-id>";
  const result = await configure.configureRepositoryRequest(session(REVIEWER_ID), repoId);
  process.env.DAYTONA_TARGET_IMAGE_DIGEST = digest;
  process.env.DAYTONA_TARGET_SNAPSHOT_ID = snapshotId;

  assert.equal(result.ok, false, "a placeholder is nonempty but not a built artifact");
  assert.equal(await boundTarget(repoId), null);
});

test("rotation requires a reviewer, same as configuring", async () => {
  const repoId = await repo();
  await configure.configureRepositoryRequest(session(REVIEWER_ID), repoId);

  const denied = await configure.rotateRepositoryTargetRequest(session(999_999), repoId);
  assert.equal(denied.ok, false);

  process.env.DAYTONA_TARGET_IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
  const allowed = await configure.rotateRepositoryTargetRequest(session(REVIEWER_ID), repoId);
  process.env.DAYTONA_TARGET_IMAGE_DIGEST = `sha256:${"0".repeat(64)}`;
  assert.equal(allowed.ok, true);

  // Every later test in this file assumes the shared profile is pinned to the default
  // digest set at the top of the file, since rotation is a real mutation of that one row.
  await configure.rotateRepositoryTargetRequest(session(REVIEWER_ID), repoId);
});

test("a pinned target mismatch does not leak its digest to the browser", async () => {
  const repoId = await repo();

  // The mismatch is actionable, but its raw error contains both image digests. The operator
  // needs the reason without exposing deployment details in the browser.
  process.env.DAYTONA_TARGET_IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
  const result = await configure.configureRepositoryRequest(session(REVIEWER_ID), repoId);
  process.env.DAYTONA_TARGET_IMAGE_DIGEST = `sha256:${"0".repeat(64)}`;

  assert.equal(result.ok, false);
  const error = (result as { error: string }).error;
  assert.match(error, /different pinned settings/);
  assert.equal(/sha256:/.test(error), false, "no digest is echoed back");
});
