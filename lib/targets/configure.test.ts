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

test("a digest composes into an image reference, or is refused", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(targets.imageRefFor(digest), `${targets.IMAGE_NAME}@${digest}`);

  for (const bad of ["", "sha256:short", `sha256:${"g".repeat(64)}`, "<sha256-of-connected-fork-build>", digest.toUpperCase()]) {
    assert.equal(targets.isValidImageDigest(bad), false, bad);
    assert.throws(() => targets.imageRefFor(bad), /not a valid image digest/);
  }
});

test("a snapshot id placeholder is rejected by shape, not by name", async () => {
  assert.equal(targets.isValidSnapshotId("snapshot-1"), true);
  assert.equal(targets.isValidSnapshotId("0619bb9e-beb2-47aa-891d-bf5e2771111c"), true);

  for (const bad of ["", "<immutable-daytona-snapshot-id>", "a b", "juice; rm -rf /"]) {
    assert.equal(targets.isValidSnapshotId(bad), false, bad);
  }
});

test("rotating a profile that does not exist yet is refused", async () => {
  // Must run before anything else creates the shared "juice-shop-v17.3.0" row: every
  // configure call in this file targets that one fixed name, so this is the only point at
  // which the profile genuinely does not exist yet.
  await connectedRepo(700_006, "acme/norotate");

  await assert.rejects(
    targets.rotateJuiceShopTarget({
      repoId: 700_006,
      imageDigest: `sha256:${"2".repeat(64)}`,
      snapshotId: "snapshot-2",
    }),
    /nothing to rotate/,
  );

  assert.equal((await dbm.db.select().from(dbm.targetProfile)).length, 0);
});

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

test("configuring a selected target profile writes an independent profile row", async () => {
  await connectedRepo(700_007, "acme/webgoat");

  const targetDefinition = {
    name: "webgoat",
    repoFullName: "Vaibhav91one/WebGoat",
    envPrefix: "WEBGOAT",
    imageName: "ghcr.io/vaibhav91one/webgoat",
    config: { baseUrl: "http://localhost:8080", readinessPath: "/WebGoat" },
    scopeRules: [{ allow: "localhost" }],
    provisioning: { readinessPath: "/WebGoat" },
  };
  const configured = await targets.configureTarget({
    repoId: 700_007,
    targetName: "webgoat",
    targetDefinition,
    imageDigest: `sha256:${"3".repeat(64)}`,
    snapshotId: "snapshot-webgoat",
    buildMarker: "webgoat-build-1",
  });

  const [row] = await dbm.db
    .select()
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.id, configured.targetProfileId));

  assert.equal(row.name, "webgoat");
  assert.equal(row.imageName, "ghcr.io/vaibhav91one/webgoat");
  assert.equal((row.config as { baseUrl?: unknown }).baseUrl, "http://localhost:8080");
  assert.deepEqual((row.config as { provisioning?: unknown }).provisioning, {
    readinessPath: "/WebGoat",
    expectedBuildMarker: "webgoat-build-1",
  });
});

test("rotating an existing profile updates it in place, keeping its id", async () => {
  await connectedRepo(700_005, "acme/rotated");
  const first = await targets.configureJuiceShopTarget({
    repoId: 700_005,
    imageDigest: `sha256:${"1".repeat(64)}`,
    snapshotId: "snapshot-1",
  });

  const rotated = await targets.rotateJuiceShopTarget({
    repoId: 700_005,
    imageDigest: `sha256:${"9".repeat(64)}`,
    snapshotId: "snapshot-9",
  });

  assert.equal(rotated.targetProfileId, first.targetProfileId, "the row is updated, not replaced");

  const [row] = await dbm.db
    .select()
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.id, first.targetProfileId));
  assert.equal(row.imageDigest, `sha256:${"9".repeat(64)}`);
  assert.equal(row.snapshotId, "snapshot-9");

  // Restore the pinned values every later test in this file assumes, since rotation is a
  // real mutation of the one shared row and not scoped to this test's own repository.
  await targets.rotateJuiceShopTarget({
    repoId: 700_005,
    imageDigest: `sha256:${"1".repeat(64)}`,
    snapshotId: "snapshot-1",
  });
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

test("a row with no image name, from before that column existed, is a mismatch too", async () => {
  // The digest and snapshot id here are exactly what the shared row already holds; only its
  // image_name is wrong, the way a row written before that column existed would be.
  await dbm.db
    .update(dbm.targetProfile)
    .set({ imageName: null })
    .where(dbm.eq(dbm.targetProfile.name, "juice-shop-v17.3.0"));

  await assert.rejects(
    targets.configureJuiceShopTarget({
      repoId: 700_001,
      imageDigest: `sha256:${"1".repeat(64)}`,
      snapshotId: "snapshot-1",
    }),
    /different pinned target settings/,
  );

  await dbm.db
    .update(dbm.targetProfile)
    .set({ imageName: targets.IMAGE_NAME })
    .where(dbm.eq(dbm.targetProfile.name, "juice-shop-v17.3.0"));
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
