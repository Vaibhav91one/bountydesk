import assert from "node:assert/strict";
import test, { after, before } from "node:test";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let targets: typeof import("./configure");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("target_configure");
  dbm = await import("@/lib/db");
  targets = await import("./configure");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

async function connectedRepo(repoId: number, fullName: string) {
  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId: repoId + 10_000, accountLogin: "acme", accountId: 77 })
    .returning({ id: dbm.githubInstallation.id });

  await dbm.db.insert(dbm.connectedRepository).values({
    installationId: installation.id,
    repoId,
    fullName,
  });
}

test("configuring the same repository twice reuses the pinned target profile", async () => {
  await connectedRepo(700_001, "acme/reports");
  const input = {
    repoId: 700_001,
    imageDigest: `sha256:${"1".repeat(64)}`,
    snapshotId: "snapshot-1",
  };

  const first = await targets.configureJuiceShopTarget(input);
  const second = await targets.configureJuiceShopTarget(input);

  assert.equal(first.targetProfileId, second.targetProfileId);
  assert.equal(
    (await dbm.db.select().from(dbm.targetProfile)).length,
    1,
  );
});

test("an existing logical profile must match every pinned setting", async () => {
  await connectedRepo(700_002, "acme/second");

  await assert.rejects(
    targets.configureJuiceShopTarget({
      repoId: 700_002,
      imageDigest: `sha256:${"2".repeat(64)}`,
      snapshotId: "another-snapshot",
    }),
    /different pinned target settings/,
  );
});

test("repository ID selects one active repository even when names are reused", async () => {
  await connectedRepo(700_003, "acme/reused");
  await connectedRepo(700_004, "acme/reused");

  const configured = await targets.configureJuiceShopTarget({
    repoId: 700_004,
    imageDigest: `sha256:${"1".repeat(64)}`,
    snapshotId: "snapshot-1",
  });

  const rows = await dbm.db
    .select({ repoId: dbm.connectedRepository.repoId, targetId: dbm.connectedRepository.targetProfileId })
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.fullName, "acme/reused"));

  assert.equal(configured.repositoryFullName, "acme/reused");
  assert.deepEqual(
    rows.sort((a, b) => a.repoId - b.repoId),
    [
      { repoId: 700_003, targetId: null },
      { repoId: 700_004, targetId: configured.targetProfileId },
    ],
  );
});
