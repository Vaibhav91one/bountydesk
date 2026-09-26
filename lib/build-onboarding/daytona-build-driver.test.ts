import assert from "node:assert/strict";
import test from "node:test";

import { createHash } from "node:crypto";

import type { Sandbox } from "@/lib/sandbox/daytona";

import { onboardingSnapshotImageRef, type BuildInput, type BuildSource } from "./build-driver";
import {
  createDaytonaBuildDriver,
  dockerEnvLine,
  imageNameFromRef,
  injectProxyTrust,
  repoSlug,
  resolveBuildSource,
  snapshotPrebuiltImage,
  stageSource,
} from "./daytona-build-driver";

const SANDBOX = {} as Sandbox;
const PLAN = {
  strategy: "dockerfile" as const,
  ecosystem: "node" as const,
  dockerfilePath: "Dockerfile",
  buildContext: ".",
  seed: { kind: "none" as const },
  runtime: { name: "app", baseUrl: "http://localhost:3000", readinessPath: "/" },
};

/** A recording SandboxRun. `results` maps a substring of a command to the stdout it should return, so
 *  a git stage can hand back the commit for `git rev-parse HEAD`; everything else returns empty. */
function fakeRun(results: Array<[string, string]> = []) {
  const commands: string[] = [];
  const run = async (_sandbox: Sandbox, command: string) => {
    commands.push(command);
    const hit = results.find(([needle]) => command.includes(needle));
    return { exitCode: 0, result: hit ? hit[1] : "" };
  };
  return { run, commands };
}

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

test("a legacy input with only an archive digest and no explicit source is refused, before Daytona", async () => {
  // Without an explicit source the driver falls back to the GitHub clone path, which needs a commit;
  // an archive digest alone does not stage anything here. A non-GitHub archive build names its source.
  const driver = createDaytonaBuildDriver();
  await assert.rejects(
    driver.build({
      repoFullName: "acme/app",
      sourceRef: "upload://acme-app.tgz",
      sourceArchiveDigest: `sha256:${"a".repeat(64)}`,
      plan: PLAN,
    }),
    /server-resolved 40-character commit SHA/,
  );
});

test("resolveBuildSource falls back to the GitHub clone path for a legacy commit input", () => {
  const source = resolveBuildSource({
    repoFullName: "acme/app",
    sourceRef: "https://github.com/acme/app.git",
    resolvedCommitSha: "a".repeat(40),
    plan: PLAN,
  });
  assert.deepEqual(source, {
    kind: "git",
    cloneUrl: "https://github.com/acme/app.git",
    resolvedCommitSha: "a".repeat(40),
  });
});

test("resolveBuildSource refuses a source whose anchor is missing or malformed", () => {
  const base = { repoFullName: "up/load", sourceRef: "upload://x", plan: PLAN };
  const bad: Array<[BuildSource, RegExp]> = [
    [{ kind: "git", cloneUrl: "https://x", resolvedCommitSha: "HEAD" }, /commit SHA/],
    [{ kind: "archive", archive: Buffer.from("x"), sourceArchiveDigest: "not-a-digest" }, /source archive digest/],
    [{ kind: "image", imageRef: "ghcr.io/x/y:tag", imageDigest: "nope" }, /sha256 digest/],
    // A digest-pinned ref cannot register as a Daytona snapshot, so it is refused at the seam.
    [{ kind: "image", imageRef: `ghcr.io/x/y@sha256:${"a".repeat(64)}`, imageDigest: `sha256:${"a".repeat(64)}` }, /plain tag reference/],
    // An image ref with a shell metacharacter or whitespace is refused at the boundary.
    [{ kind: "image", imageRef: "ghcr.io/x/y:tag; rm -rf /", imageDigest: `sha256:${"a".repeat(64)}` }, /plain tag reference/],
    [{ kind: "image", imageRef: "ghcr.io/x/y:$(id)", imageDigest: `sha256:${"a".repeat(64)}` }, /plain tag reference/],
  ];
  for (const [source, re] of bad) {
    assert.throws(() => resolveBuildSource({ ...base, source } as BuildInput), re, JSON.stringify(source));
  }
});

test("stageSource stages a git source by clone and checkout, and proves the commit landed", async () => {
  const commit = "b".repeat(40);
  const { run, commands } = fakeRun([["git rev-parse HEAD", `${commit}\n`]]);
  const { buildMarker } = await stageSource(run, SANDBOX, {
    kind: "git",
    cloneUrl: "https://github.com/acme/app.git",
    resolvedCommitSha: commit,
  });
  assert.equal(buildMarker, commit);
  assert.ok(commands.some((c) => c.includes("git clone --no-checkout")));
  assert.ok(commands.some((c) => c.includes(`git checkout --detach '${commit}'`)));
});

test("stageSource refuses a git source whose checked-out HEAD is not the requested commit", async () => {
  const { run } = fakeRun([["git rev-parse HEAD", `${"c".repeat(40)}\n`]]);
  await assert.rejects(
    stageSource(run, SANDBOX, { kind: "git", cloneUrl: "https://x", resolvedCommitSha: "d".repeat(40) }),
    /resolved to/,
  );
});

test("stageSource writes and extracts an archive, re-checks its digest in the sandbox, and never clones", async () => {
  const archive = Buffer.from("a small test-app tarball");
  const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  const { run, commands } = fakeRun();
  const { buildMarker } = await stageSource(run, SANDBOX, { kind: "archive", archive, sourceArchiveDigest: digest });

  // The archive digest is the marker for a non-git source, standing in for the commit.
  assert.equal(buildMarker, digest);
  assert.ok(!commands.some((c) => c.includes("git clone")), "an archive source must not clone");
  assert.ok(commands.some((c) => c.includes("base64 -d > /work/source.tgz")), "writes the archive");
  assert.ok(commands.some((c) => c.includes("sha256sum /work/source.tgz")), "re-checks the digest in-sandbox");
  assert.ok(commands.some((c) => c.includes("tar -xf /work/source.tgz -C /work/source")), "extracts the archive");
});

test("stageSource refuses an archive whose bytes do not hash to the declared digest, before any write", async () => {
  const { run, commands } = fakeRun();
  await assert.rejects(
    stageSource(run, SANDBOX, {
      kind: "archive",
      archive: Buffer.from("real bytes"),
      sourceArchiveDigest: `sha256:${"a".repeat(64)}`,
    }),
    /does not match the declared/,
  );
  assert.equal(commands.length, 0, "a mismatched archive is never written into the sandbox");
});

test("snapshotPrebuiltImage registers a snapshot with no build, anchored by the image digest", async () => {
  const imageDigest = `sha256:${"e".repeat(64)}`;
  const created: Array<{ name: string; image: string }> = [];
  const deleted: string[] = [];
  const ops = {
    async createSnapshot(spec: { name: string; image: string }) {
      created.push({ name: spec.name, image: spec.image });
      return { id: "snap-prebuilt", name: spec.name, state: "active" } as never;
    },
    async deleteSnapshotByName(name: string) {
      deleted.push(name);
    },
  };
  const input: BuildInput = {
    repoFullName: "vendor/app",
    sourceRef: "image://ghcr.io/vendor/app:1.2.3",
    source: { kind: "image", imageRef: "ghcr.io/vendor/app:1.2.3", imageDigest },
    plan: PLAN,
  };
  const result = await snapshotPrebuiltImage(input, input.source as Extract<BuildSource, { kind: "image" }>, ops);

  assert.equal(result.imageDigest, imageDigest);
  assert.equal(result.imageName, "ghcr.io/vendor/app");
  assert.equal(result.snapshotId, "snap-prebuilt");
  assert.equal(result.snapshotImageRef, "ghcr.io/vendor/app:1.2.3");
  // No build happened, so the marker is the image digest, and the recipe hashes to a real digest.
  assert.equal(result.buildMarker, imageDigest);
  assert.match(result.buildRecipeDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.resolvedCommitSha, undefined);
  assert.equal(result.sourceArchiveDigest, undefined);
  assert.deepEqual(created, [{ name: "onboarding-vendor-app", image: "ghcr.io/vendor/app:1.2.3" }]);
  assert.deepEqual(deleted, ["onboarding-vendor-app"]);
});

test("imageNameFromRef strips the tag but keeps a registry port", () => {
  assert.equal(imageNameFromRef("ghcr.io/vendor/app:1.2.3"), "ghcr.io/vendor/app");
  assert.equal(imageNameFromRef("ghcr.io/vendor/app"), "ghcr.io/vendor/app");
  assert.equal(imageNameFromRef("localhost:5000/app:tag"), "localhost:5000/app");
});

test("the slug is a registry-safe, lowercase identifier", () => {
  assert.equal(repoSlug("Acme-Corp/My.Repo_v2"), "acme-corp-my.repo_v2");
  // No leading, trailing, or doubled separators from stripped characters.
  assert.equal(repoSlug("weird/@@name!!"), "weird-name");
});
