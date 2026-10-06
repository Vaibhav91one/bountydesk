import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { BuildResult } from "./build-driver";
import type { TargetDefinition } from "@/lib/targets/registry";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let bind: typeof import("./connectionless-bind");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("connectionless_bind");
  // Imported after the schema is created so the shared @/lib/db points at the disposable schema,
  // never prod (see the DB test import-order note).
  dbm = await import("@/lib/db");
  bind = await import("./connectionless-bind");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function definition(name: string): TargetDefinition {
  return {
    name,
    repoFullName: "upload/none",
    envPrefix: "UPLOAD",
    // Overridden by the build's imageName; a placeholder here proves the override happens.
    imageName: "ghcr.io/placeholder/ignored",
    config: { baseUrl: "http://localhost:3000", readinessPath: "/" },
    scopeRules: [{ allow: "localhost" }],
    provisioning: { readinessPath: "/" },
  };
}

async function storedProfile(id: string) {
  const [row] = await dbm.db
    .select()
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.id, id));
  return row;
}

test("a prebuilt image binds with a marker its rebuilt image actually carries, so buildMarkerCheck passes", async () => {
  const { prebuiltImageDockerfile } = await import("./daytona-build-driver");
  // The prebuilt image's own digest is the anchor and the marker; the pushed rebuild has its own digest.
  const prebuiltDigest = `sha256:${"a".repeat(64)}`;
  const pushedDigest = `sha256:${"7".repeat(64)}`;
  const dockerfileText = prebuiltImageDockerfile({ kind: "image", imageRef: "ghcr.io/vendor/app:1.2.3", imageDigest: prebuiltDigest });
  const build: BuildResult = {
    imageName: "ghcr.io/ns/vendor-app",
    imageDigest: pushedDigest,
    snapshotId: "snap-image",
    dockerfileText,
    buildLog: "built FROM the pinned digest",
    buildMarker: prebuiltDigest,
    buildRecipeDigest: `sha256:${"1".repeat(64)}`,
  };

  const configured = await bind.bindConnectionlessTargetFromBuild(definition("prebuilt-image"), build);
  assert.equal(configured.repositoryId, null);

  const row = await storedProfile(configured.targetProfileId);
  assert.equal(row.imageName, "ghcr.io/ns/vendor-app");
  assert.equal(row.imageDigest, pushedDigest);
  assert.equal(row.resolvedCommitSha, null);
  assert.equal(row.sourceArchiveDigest, null);
  const provisioning = (row.config as { provisioning?: { expectedBuildMarker?: string; snapshotImageRefOverride?: string } })
    .provisioning;
  // Reproduction's buildMarkerCheck compares what /etc/bountydesk-build-marker holds in the booted image
  // with the profile's expectedBuildMarker; the rebuilt image bakes exactly that value.
  assert.equal(provisioning?.expectedBuildMarker, prebuiltDigest);
  assert.ok(dockerfileText.includes(`echo '${provisioning?.expectedBuildMarker}' > /etc/bountydesk-build-marker`));
  // Pushed and snapshotted under the onboarding tag like any repo build.
  assert.equal(provisioning?.snapshotImageRefOverride, "ghcr.io/ns/vendor-app:bountydesk-onboarding");
});

test("an uploaded tarball binds with its source archive digest as the anchor", async () => {
  const sourceArchiveDigest = `sha256:${"b".repeat(64)}`;
  const build: BuildResult = {
    imageName: "ghcr.io/ns/uploaded-tarball",
    imageDigest: `sha256:${"c".repeat(64)}`,
    snapshotId: "snap-tarball",
    dockerfileText: "FROM node:20\n",
    buildLog: "built from tarball",
    buildMarker: sourceArchiveDigest,
    buildRecipeDigest: `sha256:${"2".repeat(64)}`,
    sourceArchiveDigest,
  };

  const configured = await bind.bindConnectionlessTargetFromBuild(definition("uploaded-tarball"), build);
  const row = await storedProfile(configured.targetProfileId);
  assert.equal(row.sourceArchiveDigest, sourceArchiveDigest);
  assert.equal(row.resolvedCommitSha, null);
  assert.equal(row.dockerfileText, "FROM node:20\n");
  // With no explicit snapshot ref, a repo build uses the default onboarding tag on its image.
  assert.equal(
    (row.config as { provisioning?: { snapshotImageRefOverride?: string } }).provisioning?.snapshotImageRefOverride,
    "ghcr.io/ns/uploaded-tarball:bountydesk-onboarding",
  );
});

test("an uploaded Dockerfile and a generated Dockerfile both bind on the archive digest", async () => {
  for (const name of ["uploaded-dockerfile", "generated-dockerfile"]) {
    const sourceArchiveDigest = `sha256:${(name === "uploaded-dockerfile" ? "d" : "e").repeat(64)}`;
    const build: BuildResult = {
      imageName: `ghcr.io/ns/${name}`,
      imageDigest: `sha256:${"f".repeat(64)}`,
      snapshotId: `snap-${name}`,
      dockerfileText: "FROM alpine\nCMD sleep 1\n",
      buildLog: "built",
      buildMarker: sourceArchiveDigest,
      buildRecipeDigest: `sha256:${"3".repeat(64)}`,
      sourceArchiveDigest,
    };
    const configured = await bind.bindConnectionlessTargetFromBuild(definition(name), build);
    const row = await storedProfile(configured.targetProfileId);
    assert.equal(row.sourceArchiveDigest, sourceArchiveDigest, name);
    assert.equal(row.resolvedCommitSha, null, name);
  }
});

test("a git-cloned source binds with the commit as the anchor", async () => {
  const commit = "a".repeat(40);
  const build: BuildResult = {
    imageName: "ghcr.io/ns/cloned",
    imageDigest: `sha256:${"9".repeat(64)}`,
    snapshotId: "snap-git",
    dockerfileText: "FROM node:20\n",
    buildLog: "built from clone",
    buildMarker: commit,
    buildRecipeDigest: `sha256:${"4".repeat(64)}`,
    resolvedCommitSha: commit,
  };
  const configured = await bind.bindConnectionlessTargetFromBuild(definition("cloned-source"), build);
  const row = await storedProfile(configured.targetProfileId);
  assert.equal(row.resolvedCommitSha, commit);
  assert.equal(row.sourceArchiveDigest, null);
  // A repo build reports no snapshotImageRef, so the bind falls back to the default onboarding tag on
  // the build's image.
  assert.equal(
    (row.config as { provisioning?: { snapshotImageRefOverride?: string } }).provisioning?.snapshotImageRefOverride,
    "ghcr.io/ns/cloned:bountydesk-onboarding",
  );
});

test("a build with no recipe digest is refused before any profile is written", async () => {
  const build = {
    imageName: "ghcr.io/ns/no-recipe",
    imageDigest: `sha256:${"a".repeat(64)}`,
    snapshotId: "snap-none",
    dockerfileText: "",
    buildLog: "",
    buildMarker: `sha256:${"a".repeat(64)}`,
    // buildRecipeDigest deliberately omitted.
  } as unknown as BuildResult;

  await assert.rejects(
    bind.bindConnectionlessTargetFromBuild(definition("no-recipe"), build),
    /requires build identity/,
  );
  const rows = await dbm.db
    .select({ id: dbm.targetProfile.id })
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.name, "no-recipe"));
  assert.equal(rows.length, 0);
});

test("re-onboarding a connectionless target with changed pins rotates the profile in place", async () => {
  const first: BuildResult = {
    imageName: "ghcr.io/ns/reonboard",
    imageDigest: `sha256:${"a".repeat(64)}`,
    snapshotId: "snap-1",
    dockerfileText: "FROM node:20\n",
    buildLog: "built once",
    buildMarker: `sha256:${"b".repeat(64)}`,
    buildRecipeDigest: `sha256:${"1".repeat(64)}`,
    sourceArchiveDigest: `sha256:${"b".repeat(64)}`,
  };
  const configured = await bind.bindConnectionlessTargetFromBuild(definition("reonboard"), first);
  assert.ok(configured.targetProfileId);

  // Same target name, a rebuild that produced a different image and recipe.
  const second: BuildResult = {
    ...first,
    imageDigest: `sha256:${"c".repeat(64)}`,
    snapshotId: "snap-2",
    buildRecipeDigest: `sha256:${"2".repeat(64)}`,
  };
  const rotated = await bind.bindConnectionlessTargetFromBuild(definition("reonboard"), second, {
    mayRotate: async () => true,
  });

  // The row id is kept, so reports already bound to the profile stay bound.
  assert.equal(rotated.targetProfileId, configured.targetProfileId);
  const row = await storedProfile(configured.targetProfileId);
  assert.equal(row.imageDigest, `sha256:${"c".repeat(64)}`);
  assert.equal(row.snapshotId, "snap-2");
  assert.equal(row.buildRecipeDigest, `sha256:${"2".repeat(64)}`);
});

test("a stale or unproven re-bind with a different digest fails safe and leaves the profile alone", async () => {
  const { TargetProfileExistsError } = await import("@/lib/targets/configure");
  const first: BuildResult = {
    imageName: "ghcr.io/ns/stale",
    imageDigest: `sha256:${"a".repeat(64)}`,
    snapshotId: "snap-1",
    dockerfileText: "FROM node:20\n",
    buildLog: "",
    buildMarker: `sha256:${"b".repeat(64)}`,
    buildRecipeDigest: `sha256:${"1".repeat(64)}`,
    sourceArchiveDigest: `sha256:${"b".repeat(64)}`,
  };
  const configured = await bind.bindConnectionlessTargetFromBuild(definition("stale"), first);
  const stale: BuildResult = { ...first, imageDigest: `sha256:${"d".repeat(64)}`, snapshotId: "snap-stale" };

  for (const opts of [undefined, { mayRotate: async () => false }]) {
    await assert.rejects(
      bind.bindConnectionlessTargetFromBuild(definition("stale"), stale, opts),
      (error: unknown) => error instanceof TargetProfileExistsError,
    );
  }
  const row = await storedProfile(configured.targetProfileId);
  assert.equal(row.imageDigest, first.imageDigest);
  assert.equal(row.snapshotId, "snap-1");
});

test("rotating a connectionless target that does not exist throws", async () => {
  const { rotateConnectionlessTarget } = await import("@/lib/targets/configure");
  await assert.rejects(
    rotateConnectionlessTarget({
      targetDefinition: definition("never-bound"),
      imageDigest: `sha256:${"a".repeat(64)}`,
      snapshotId: "snap-x",
      buildMarker: `sha256:${"a".repeat(64)}`,
      buildRecipeDigest: `sha256:${"1".repeat(64)}`,
      sourceArchiveDigest: `sha256:${"a".repeat(64)}`,
    }),
    /does not exist yet; nothing to rotate/,
  );
});

test("a mesh build stores a manifest that matches the written config and carries the build's image name", async () => {
  const services = [
    { service: "app", role: "app" as const, imageName: "ghcr.io/ns/mesh-app", imageDigest: `sha256:${"4".repeat(64)}`, snapshotId: "snap-app", snapshotImageRef: "ghcr.io/ns/mesh-app:bountydesk-onboarding", port: 3000 },
    { service: "db", role: "dependency" as const, imageName: "docker.io/library/postgres", imageDigest: `sha256:${"5".repeat(64)}`, snapshotId: "snap-db", snapshotImageRef: "docker.io/library/postgres:bountydesk-onboarding", port: 5432 },
  ] satisfies NonNullable<BuildResult["services"]>;
  const build: BuildResult = {
    imageName: "ghcr.io/ns/mesh-app",
    imageDigest: `sha256:${"4".repeat(64)}`,
    snapshotId: "snap-app",
    dockerfileText: "FROM node:20\n",
    buildLog: "built mesh",
    buildMarker: "mesh-marker",
    buildRecipeDigest: `sha256:${"6".repeat(64)}`,
    sourceArchiveDigest: `sha256:${"7".repeat(64)}`,
    services,
  };
  const configured = await bind.bindConnectionlessTargetFromBuild(definition("mesh-target"), build);
  const row = await storedProfile(configured.targetProfileId);
  const manifest = row.manifest as TargetDefinition;
  assert.equal(manifest.imageName, "ghcr.io/ns/mesh-app");
  assert.deepEqual(manifest.config.services, services);
  assert.deepEqual((row.config as { services?: unknown }).services, manifest.config.services);
});
