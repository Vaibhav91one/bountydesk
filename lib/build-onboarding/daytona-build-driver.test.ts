import assert from "node:assert/strict";
import test from "node:test";

import { onboardingSnapshotImageRef } from "./build-driver";
import { imageNameOf, injectProxyTrust, repoSlug } from "./daytona-build-driver";

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

test("injectProxyTrust adds the trust env after each FROM and nowhere else", () => {
  const df = "FROM python:3.9-slim AS base\nRUN pip install flask\nFROM base\nCMD [\"python\",\"app.py\"]\n";
  const out = injectProxyTrust(df);
  // One env line per FROM (two stages here), and the trust for pip's hosts is present.
  assert.equal(out.match(/PIP_TRUSTED_HOST/g)?.length, 2);
  assert.match(out, /FROM python:3.9-slim AS base\nENV PIP_TRUSTED_HOST/);
  assert.match(out, /FROM base\nENV PIP_TRUSTED_HOST/);
  // A RUN line is untouched.
  assert.match(out, /\nRUN pip install flask\n/);
});

test("injectProxyTrust leaves a Dockerfile with no FROM unchanged", () => {
  assert.equal(injectProxyTrust("RUN echo hi\n"), "RUN echo hi\n");
});

test("imageNameOf strips a tag or digest but keeps a registry host and port", () => {
  assert.equal(imageNameOf("postgres:16"), "postgres");
  assert.equal(imageNameOf("redis"), "redis");
  assert.equal(imageNameOf("ghcr.io/acme/api:v1"), "ghcr.io/acme/api");
  assert.equal(imageNameOf("ghcr.io/acme/api@sha256:" + "a".repeat(64)), "ghcr.io/acme/api");
  // A registry host:port prefix is not a tag and must survive.
  assert.equal(imageNameOf("localhost:5000/api:v2"), "localhost:5000/api");
});

test("the slug is a registry-safe, lowercase identifier", () => {
  assert.equal(repoSlug("Acme-Corp/My.Repo_v2"), "acme-corp-my.repo_v2");
  // No leading, trailing, or doubled separators from stripped characters.
  assert.equal(repoSlug("weird/@@name!!"), "weird-name");
});
