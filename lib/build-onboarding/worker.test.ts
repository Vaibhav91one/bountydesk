import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { BuildDriver, BuildResult } from "./build-driver";
import type { OnboardDeps } from "./worker";
import type { TrueForgeClient } from "@/lib/trueforge/client";

/**
 * The whole onboarding software path, end to end, against fakes: a fake BuildDriver (no Daytona),
 * a fake TrueForge client returning a canned manifest (no harness), and a fake provision (no live
 * sandbox). Only the DB is real, on a disposable schema. This proves the state machine, the
 * manifest validation, the human gate, and the TargetProfile write without any live infra.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let queue: typeof import("./queue");
let worker: typeof import("./worker");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("target_onboarding_worker");
  dbm = await import("@/lib/db");
  queue = await import("./queue");
  worker = await import("./worker");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function connectedRepo(fullName: string): Promise<number> {
  seq += 1;
  const repoId = 500_000 + seq;
  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId: repoId + 10_000, accountLogin: "acme", accountId: 77 })
    .returning({ id: dbm.githubInstallation.id });
  await dbm.db
    .insert(dbm.connectedRepository)
    .values({ installationId: installation.id, repoId, fullName });
  return repoId;
}

function manifestJson(repoFullName: string): string {
  return JSON.stringify({
    name: "widget",
    repoFullName,
    imageName: "ghcr.io/acme/widget",
    baseUrl: "http://localhost:3000",
    readinessPath: "/",
    startCommand: "node server.js",
    scopeRules: [{ allow: "localhost" }],
  });
}

const buildResult: BuildResult = {
  imageName: "ghcr.io/acme/widget",
  imageDigest: `sha256:${"a".repeat(64)}`,
  snapshotId: "snap-widget",
  dockerfileText: "FROM node:20\nCMD node server.js",
  buildMarker: "b".repeat(40),
};

function fakeBuildDriver(over?: Partial<BuildResult> | Error): BuildDriver {
  return {
    async build() {
      if (over instanceof Error) throw over;
      return { ...buildResult, ...over };
    },
  };
}

/** A TrueForge client that answers just the four calls proposeManifest makes. */
function fakeAgentClient(finalMessage: string | null): TrueForgeClient {
  return {
    async createSession() {
      return { sessionId: "s-1" };
    },
    async deleteSession() {},
    async createTurn() {
      return { turnId: "t-1", snapshot: { status: "running" } };
    },
    async getTurn() {
      return { status: "done_no_action" };
    },
    async getTurnInput() {
      return [];
    },
    async getFinalSummary() {
      return finalMessage;
    },
  } as unknown as TrueForgeClient;
}

function deps(over: Partial<OnboardDeps>): OnboardDeps {
  return {
    buildDriver: fakeBuildDriver(),
    agentClient: fakeAgentClient(manifestJson("acme/widget")),
    provision: async () => ({ sandboxId: "sbx-verify", appPort: 3000 }),
    teardown: async () => {},
    leaseSeconds: 60,
    ...over,
  };
}

/** Park every existing row terminal so onboardOnce (global-FIFO claim) picks only this test's
 *  freshly enqueued row. */
async function drain() {
  await dbm.db
    .update(dbm.targetOnboarding)
    .set({ state: "CONFIGURED", leaseOwner: null, leaseExpiresAt: null });
}

async function stateOf(repoId: number): Promise<string> {
  const [row] = await dbm.db
    .select({ state: dbm.targetOnboarding.state })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));
  return row.state;
}

test("the build step stores its outputs and advances to the manifest step", async () => {
  const repoId = await connectedRepo("acme/widget");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/widget", sourceRef: "https://x/widget.git" });

  await worker.onboardOnce("w1", deps({}));

  assert.equal(await stateOf(repoId), "PENDING_MANIFEST");
  const [row] = await dbm.db
    .select({ imageDigest: dbm.targetOnboarding.imageDigest, dockerfileText: dbm.targetOnboarding.dockerfileText })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));
  assert.equal(row.imageDigest, buildResult.imageDigest);
  assert.match(row.dockerfileText ?? "", /FROM node:20/);
});

test("a valid manifest reaches the human gate; an invalid one fails for retry", async () => {
  const repoId = await connectedRepo("acme/widget");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/widget", sourceRef: "https://x/widget.git" });

  await worker.onboardOnce("w1", deps({})); // build -> PENDING_MANIFEST

  // An unparseable manifest keeps the row at PENDING_MANIFEST (retryable) and records the error.
  await worker.onboardOnce("w1", deps({ agentClient: fakeAgentClient("not json at all") }));
  assert.equal(await stateOf(repoId), "PENDING_MANIFEST");

  // Clear the failure backoff so the retry is claimable now (the worker would just wait).
  await dbm.db
    .update(dbm.targetOnboarding)
    .set({ nextAttemptAt: new Date() })
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));

  // A valid manifest advances to the gate.
  await worker.onboardOnce("w1", deps({}));
  assert.equal(await stateOf(repoId), "AWAITING_APPROVAL");
  const [row] = await dbm.db
    .select({ manifest: dbm.targetOnboarding.proposedManifest })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));
  assert.equal((row.manifest as { name?: string }).name, "widget");
});

test("the worker never advances a row out of AWAITING_APPROVAL on its own", async () => {
  const repoId = await connectedRepo("acme/widget");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/widget", sourceRef: "https://x/widget.git" });
  await worker.onboardOnce("w1", deps({}));
  await worker.onboardOnce("w1", deps({}));
  assert.equal(await stateOf(repoId), "AWAITING_APPROVAL");

  // Repeated claims cannot pick it up: it stays put until a human moves it to APPROVED.
  await worker.onboardOnce("w1", deps({}));
  assert.equal(await stateOf(repoId), "AWAITING_APPROVAL");
});

test("an approved row verifies offline and writes the TargetProfile", async () => {
  const repoId = await connectedRepo("acme/widget");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/widget", sourceRef: "https://x/widget.git" });
  await worker.onboardOnce("w1", deps({}));
  await worker.onboardOnce("w1", deps({}));

  // Human approval.
  await dbm.db
    .update(dbm.targetOnboarding)
    .set({ state: "APPROVED", approvedBy: "octocat", approvedAt: new Date() })
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));

  let verified = false;
  let toreDown = false;
  await worker.onboardOnce(
    "w1",
    deps({
      provision: async () => {
        verified = true;
        return { sandboxId: "sbx", appPort: 3000 };
      },
      teardown: async () => {
        toreDown = true;
      },
    }),
  );

  assert.equal(verified, true);
  assert.equal(toreDown, true);
  assert.equal(await stateOf(repoId), "CONFIGURED");

  const [profile] = await dbm.db
    .select({ name: dbm.targetProfile.name, dockerfileText: dbm.targetProfile.dockerfileText })
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.name, "widget"));
  assert.ok(profile);
  assert.match(profile.dockerfileText ?? "", /FROM node:20/);

  const [repo] = await dbm.db
    .select({ targetProfileId: dbm.connectedRepository.targetProfileId })
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId));
  assert.ok(repo.targetProfileId);
});

test("a failed offline verify leaves the row unwritten", async () => {
  const repoId = await connectedRepo("acme/widget");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/widget", sourceRef: "https://x/widget.git" });
  await worker.onboardOnce("w1", deps({}));
  await worker.onboardOnce("w1", deps({}));
  await dbm.db
    .update(dbm.targetOnboarding)
    .set({ state: "APPROVED" })
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));

  await worker.onboardOnce(
    "w1",
    deps({
      provision: async () => {
        throw new Error("egress was not blocked");
      },
    }),
  );

  // Still APPROVED (retryable), and this repo is left unbound: a failed verify never binds a
  // target. (A "widget" profile may exist from another test in this shared schema; what matters
  // is that this repo did not get bound to one.)
  assert.equal(await stateOf(repoId), "APPROVED");
  const [repo] = await dbm.db
    .select({ targetProfileId: dbm.connectedRepository.targetProfileId })
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId));
  assert.equal(repo.targetProfileId, null);
});
