import assert from "node:assert/strict";
import test from "node:test";

import { isCommitSha, sourceIdentityDigest } from "./source-identity";

test("commit identity accepts only full SHA values", () => {
  assert.equal(isCommitSha("a".repeat(40)), true);
  assert.equal(isCommitSha("a".repeat(39)), false);
  assert.equal(isCommitSha("HEAD"), false);
  assert.equal(isCommitSha("g".repeat(40)), false);
});

test("source identity digest includes every service and is stable across service order", () => {
  const base = {
    repoFullName: "acme/mesh",
    resolvedCommitSha: "a".repeat(40),
    sourceArchiveDigest: "sha256:" + "b".repeat(64),
    plan: { strategy: "compose-mesh", services: ["web", "db"] },
    buildBaseSnapshot: "build-snapshot",
  };
  const one = sourceIdentityDigest({
    ...base,
    services: [
      { service: "db", imageDigest: "sha256:" + "d".repeat(64), snapshotId: "snap-db" },
      { service: "web", imageDigest: "sha256:" + "e".repeat(64), snapshotId: "snap-web" },
    ],
  });
  const two = sourceIdentityDigest({
    ...base,
    services: [
      { service: "web", imageDigest: "sha256:" + "e".repeat(64), snapshotId: "snap-web" },
      { service: "db", imageDigest: "sha256:" + "d".repeat(64), snapshotId: "snap-db" },
    ],
  });
  assert.equal(one, two);
  assert.notEqual(one, sourceIdentityDigest({ ...base, services: [{ service: "db", imageDigest: "sha256:" + "f".repeat(64), snapshotId: "snap-db" }] }));
});

test("the recipe digest changes with each identity input", () => {
  const base = {
    repoFullName: "acme/mesh",
    resolvedCommitSha: "a".repeat(40),
    plan: { strategy: "compose-mesh" },
    imageDigest: "sha256:" + "1".repeat(64),
    buildMarker: "a".repeat(40),
  };
  const digest = sourceIdentityDigest(base);

  // The commit, the app digest, and the plan each move the digest.
  assert.notEqual(digest, sourceIdentityDigest({ ...base, resolvedCommitSha: "b".repeat(40) }));
  assert.notEqual(digest, sourceIdentityDigest({ ...base, imageDigest: "sha256:" + "2".repeat(64) }));
  assert.notEqual(digest, sourceIdentityDigest({ ...base, plan: { strategy: "dockerfile" } }));

  // A mutable ref is refused outright rather than hashed into a stable-looking identity.
  assert.throws(() => sourceIdentityDigest({ ...base, resolvedCommitSha: "HEAD" }), /full commit SHA/);
});
