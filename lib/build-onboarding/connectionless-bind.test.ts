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

test("a prebuilt image binds with its own digest as the anchor and no commit or archive digest", async () => {
  const imageDigest = `sha256:${"a".repeat(64)}`;
  const build: BuildResult = {
    imageName: "ghcr.io/vendor/app",
    imageDigest,
    snapshotId: "snap-image",
    dockerfileText: "",
    buildLog: "[prebuilt image] ...",
    buildMarker: imageDigest,
    buildRecipeDigest: `sha256:${"1".repeat(64)}`,
    snapshotImageRef: "ghcr.io/vendor/app:1.2.3",
  };

  const configured = await bind.bindConnectionlessTargetFromBuild(definition("prebuilt-image"), build);
  assert.equal(configured.repositoryId, null);

  const row = await storedProfile(configured.targetProfileId);
  assert.equal(row.imageName, "ghcr.io/vendor/app");
  assert.equal(row.imageDigest, imageDigest);
  assert.equal(row.resolvedCommitSha, null);
  assert.equal(row.sourceArchiveDigest, null);
  // The snapshot is registered under the image's own ref, so the profile pins that exact tag.
  assert.equal(
    (row.config as { provisioning?: { snapshotImageRefOverride?: string } }).provisioning?.snapshotImageRefOverride,
    "ghcr.io/vendor/app:1.2.3",
  );
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
