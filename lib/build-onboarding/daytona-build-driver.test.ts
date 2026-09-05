import assert from "node:assert/strict";
import test from "node:test";

import { onboardingSnapshotImageRef } from "./build-driver";
import { repoSlug } from "./daytona-build-driver";

/**
 * The driver itself talks to live Daytona and a registry, so it is not unit-tested here. Its one
 * pure decision is worth a test on its own: how a repository name becomes an image and snapshot
 * identity, because getting that wrong collides two different customers' targets onto one image.
 */
test("the slug keeps the whole owner/name, so a shared final name does not collide", () => {
  const alice = repoSlug("alice/api");
  const bob = repoSlug("bob/api");
  assert.notEqual(alice, bob);
  assert.notEqual(
    onboardingSnapshotImageRef(`ghcr.io/ns/${alice}`),
    onboardingSnapshotImageRef(`ghcr.io/ns/${bob}`),
  );
});

test("the slug is a registry-safe, lowercase identifier", () => {
  assert.equal(repoSlug("Acme-Corp/My.Repo_v2"), "acme-corp-my.repo_v2");
  // No leading, trailing, or doubled separators from stripped characters.
  assert.equal(repoSlug("weird/@@name!!"), "weird-name");
});
