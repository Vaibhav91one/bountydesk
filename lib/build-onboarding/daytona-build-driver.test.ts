import assert from "node:assert/strict";
import test from "node:test";

import { onboardingSnapshotImageRef } from "./build-driver";
import { createDaytonaBuildDriver, dockerEnvLine, injectProxyTrust, repoSlug } from "./daytona-build-driver";

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

test("injectProxyTrust disables Alpine apk certificate checks", () => {
  const out = injectProxyTrust("FROM alpine:3.24\nRUN apk add --update --no-cache curl\n");
  assert.match(out, /apk --no-check-certificate add --update --no-cache curl/);
});

test("injectProxyTrust does not duplicate Alpine certificate flags", () => {
  const out = injectProxyTrust("FROM alpine:3.24\nRUN apk --no-check-certificate add curl\n");
  assert.equal(out.match(/--no-check-certificate/g)?.length, 1);
});

test("injectProxyTrust handles chained apk installs without touching data", () => {
  const out = injectProxyTrust(
    "FROM alpine:3.24\n# apk add should stay unchanged\nENV NOTE=\"apk add unchanged\"\nRUN apk update && apk add curl\n",
  );
  assert.match(out, /apk update && apk --no-check-certificate add curl/);
  assert.match(out, /# apk add should stay unchanged/);
  assert.match(out, /ENV NOTE=\"apk add unchanged\"/);
});

test("dockerEnvLine bakes a service's compose env, quoting values, and is empty for none", () => {
  assert.equal(dockerEnvLine(undefined), "");
  assert.equal(dockerEnvLine({}), "");
  const line = dockerEnvLine({ POSTGRES_PASSWORD: "postgres", DB_HOST: "db" });
  assert.match(line, /^ENV /);
  assert.match(line, /POSTGRES_PASSWORD="postgres"/);
  // A value naming a peer service is kept verbatim; /etc/hosts resolves it at provision time.
  assert.match(line, /DB_HOST="db"/);
  assert.match(line, /\n$/);
});

test("injectProxyTrust leaves a Dockerfile with no FROM unchanged", () => {
  assert.equal(injectProxyTrust("RUN echo hi\n"), "RUN echo hi\n");
});

test("the driver refuses to build without a server-resolved commit, before touching Daytona", async () => {
  // No DAYTONA_API_KEY and no BUILD_BASE_SNAPSHOT are set here: if the driver reached the provider
  // it would fail on an env read instead of the identity check, which is the thing under test.
  const driver = createDaytonaBuildDriver();
  const plan = {
    strategy: "dockerfile" as const,
    ecosystem: "node" as const,
    dockerfilePath: "Dockerfile",
    buildContext: ".",
    seed: { kind: "none" as const },
    runtime: { name: "app", baseUrl: "http://localhost:3000", readinessPath: "/" },
  };

  for (const missing of [undefined, "HEAD", "main", "abc123", "a".repeat(39)]) {
    await assert.rejects(
      driver.build({ repoFullName: "acme/app", sourceRef: "https://github.com/acme/app.git", resolvedCommitSha: missing, plan }),
      /server-resolved 40-character commit SHA/,
      `${String(missing)} must never reach a build`,
    );
  }
});

test("the slug is a registry-safe, lowercase identifier", () => {
  assert.equal(repoSlug("Acme-Corp/My.Repo_v2"), "acme-corp-my.repo_v2");
  // No leading, trailing, or doubled separators from stripped characters.
  assert.equal(repoSlug("weird/@@name!!"), "weird-name");
});
