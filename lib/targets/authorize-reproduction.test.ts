import assert from "node:assert/strict";
import test, { after, before } from "node:test";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let authorize: typeof import("./authorize-reproduction");

const VALID_CONFIG = {
  baseUrl: "https://sandbox.example.com",
  searchPath: "/rest/products/search",
  canaryRegistrationPath: "/api/Users",
};

// getRecipesForTarget only recognizes the exact name "juice-shop-v17.3.0", so every test in
// this file shares the one row (that name is also unique-indexed) and restores it afterward,
// the same pattern lib/targets/configure.test.ts already uses for the same constraint.
let profileId: string;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("authorize_reproduction");
  dbm = await import("@/lib/db");
  authorize = await import("./authorize-reproduction");

  const [row] = await dbm.db
    .insert(dbm.targetProfile)
    .values({
      name: "juice-shop-v17.3.0",
      imageName: "ghcr.io/vaibhav91one/juice-shop",
      imageDigest: `sha256:${"1".repeat(64)}`,
      snapshotId: "snapshot-1",
      config: VALID_CONFIG,
    })
    .returning({ id: dbm.targetProfile.id });
  profileId = row.id;
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

async function restoreProfile() {
  await dbm.db
    .update(dbm.targetProfile)
    .set({ imageName: "ghcr.io/vaibhav91one/juice-shop", config: VALID_CONFIG })
    .where(dbm.eq(dbm.targetProfile.id, profileId));
}

test("a bound target with a matching recipe resolves everything from the DB row, not the caller", async () => {
  const result = await authorize.authorizeReproductionTarget({
    targetProfileId: profileId,
    recipeId: "juice-shop-sqli-search",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.imageName, "ghcr.io/vaibhav91one/juice-shop");
  assert.equal(result.imageDigest, `sha256:${"1".repeat(64)}`);
  assert.equal(result.snapshotId, "snapshot-1");
  assert.equal(result.appPort, 443, "https baseUrl with no explicit port defaults to 443");
  assert.equal(result.recipe.id, "juice-shop-sqli-search");
  assert.equal(result.readinessPath, "/");
  assert.equal(result.expectedBuildMarker, "1867b926c5f50e4e692dc9c8f61821413cebe0cd");
});

test("an unknown target profile id is refused, not treated as a caller-supplied target", async () => {
  const result = await authorize.authorizeReproductionTarget({
    targetProfileId: "00000000-0000-0000-0000-000000000000",
    recipeId: "juice-shop-sqli-search",
  });

  assert.deepEqual(result, { ok: false, reason: "NO_BOUND_TARGET" });
});

test("meshServicesFromConfig is null for a single-image profile and maps a mesh profile", () => {
  assert.equal(authorize.meshServicesFromConfig({ baseUrl: "http://localhost:80" }), null);
  assert.equal(authorize.meshServicesFromConfig({ services: [] }), null);

  const services = authorize.meshServicesFromConfig({
    services: [
      {
        service: "web",
        role: "app",
        imageName: "ghcr.io/x/web",
        imageDigest: "sha256:" + "a".repeat(64),
        snapshotId: "snap-web",
        snapshotImageRef: "ghcr.io/x/web:bountydesk-onboarding",
        port: 8000,
        buildMarker: "abc",
        startCommand: "node app.js",
        peers: ["db"],
      },
      { service: "db", role: "dependency", imageName: "postgres", imageDigest: "sha256:" + "b".repeat(64), snapshotId: "snap-db", port: 5432 },
    ],
  });
  assert.ok(services);
  assert.equal(services!.length, 2);
  const web = services!.find((s) => s.role === "app")!;
  assert.equal(web.snapshotImageRefOverride, "ghcr.io/x/web:bountydesk-onboarding");
  assert.equal(web.startCommand, "node app.js");
  assert.deepEqual(web.peers, ["db"]);
  const db = services!.find((s) => s.role === "dependency")!;
  assert.equal(db.port, 5432);
  assert.equal(db.startCommand, undefined);
});

test("meshServicesFromConfig refuses a mesh with no app service", () => {
  assert.throws(
    () =>
      authorize.meshServicesFromConfig({
        services: [{ service: "db", role: "dependency", imageName: "postgres", imageDigest: "sha256:" + "b".repeat(64), snapshotId: "snap-db" }],
      }),
    /no app service/,
  );
});

test("a profile with no image name cannot be authorized for a live run", async () => {
  await dbm.db.update(dbm.targetProfile).set({ imageName: null }).where(dbm.eq(dbm.targetProfile.id, profileId));

  try {
    const result = await authorize.authorizeReproductionTarget({
      targetProfileId: profileId,
      recipeId: "juice-shop-sqli-search",
    });
    assert.deepEqual(result, { ok: false, reason: "COULD_NOT_DEPLOY" });
  } finally {
    await restoreProfile();
  }
});

test("a profile whose config carries no usable app port has no approved oracle", async () => {
  await dbm.db
    .update(dbm.targetProfile)
    .set({ config: { searchPath: "/rest/products/search" } })
    .where(dbm.eq(dbm.targetProfile.id, profileId));

  try {
    const result = await authorize.authorizeReproductionTarget({
      targetProfileId: profileId,
      recipeId: "juice-shop-sqli-search",
    });
    assert.deepEqual(result, { ok: false, reason: "NO_APPROVED_ORACLE" });
  } finally {
    await restoreProfile();
  }
});

test("a profile with no registry entry or stored provisioning is not deployable", async () => {
  const [row] = await dbm.db
    .insert(dbm.targetProfile)
    .values({
      name: "unknown-target",
      imageName: "ghcr.io/example/unknown-target",
      imageDigest: `sha256:${"2".repeat(64)}`,
      snapshotId: "snapshot-unknown",
      config: { baseUrl: "http://localhost:8080" },
    })
    .returning({ id: dbm.targetProfile.id });

  const result = await authorize.authorizeReproductionTarget({
    targetProfileId: row.id,
    recipeId: "juice-shop-sqli-search",
  });

  assert.deepEqual(result, { ok: false, reason: "COULD_NOT_DEPLOY" });
});

test("a recipe id that this target does not offer is refused, even for an otherwise-valid target", async () => {
  const result = await authorize.authorizeReproductionTarget({
    targetProfileId: profileId,
    recipeId: "not-a-real-recipe",
  });

  assert.deepEqual(result, { ok: false, reason: "NO_APPROVED_ORACLE" });
});
