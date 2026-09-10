import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { BuildDriver, BuildResult } from "./build-driver";
import type { BuildPlan } from "./build-plan";
import type { OnboardDeps } from "./worker";
import type { TrueForgeClient } from "@/lib/trueforge/client";

/**
 * The whole onboarding software path, end to end, against fakes: a fake classifier (no source
 * fetch), a fake BuildDriver (no Daytona), and a fake provision (no live sandbox). Only the DB is
 * real, on a disposable schema. This proves the state machine (plan, build, manifest, human gate,
 * verify, write) and the manifest validation without any live infra.
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

test("malformed stored mesh services fail closed instead of downgrading", async () => {
  const { parseBuiltServices } = await import("./worker");
  assert.equal(parseBuiltServices(null), null);
  assert.throws(() => parseBuiltServices({}), /nonempty array/);
  assert.throws(() => parseBuiltServices([]), /nonempty array/);
  assert.throws(
    () => parseBuiltServices([{ service: "web", role: "app", imageName: "x", imageDigest: "mutable", snapshotId: "snap" }]),
    /malformed/,
  );
});

test("mesh start commands run inside the service and reject host container commands", async () => {
  const { assertSafeMeshStartCommand } = await import("./worker");
  assert.equal(assertSafeMeshStartCommand("web", "  ./start.sh  "), "./start.sh");
  assert.equal(assertSafeMeshStartCommand("db", "docker-entrypoint.sh postgres"), "docker-entrypoint.sh postgres");
  assert.throws(() => assertSafeMeshStartCommand("db", "docker run postgres"), /host-level/);
  assert.throws(() => assertSafeMeshStartCommand("db", "cd /app && docker run postgres"), /host-level/);
  assert.throws(() => assertSafeMeshStartCommand("db", "cd /app && podman run postgres"), /host-level/);
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

const widgetPlan: BuildPlan = {
  strategy: "dockerfile",
  ecosystem: "node",
  dockerfilePath: "Dockerfile",
  buildContext: ".",
  seed: { kind: "none" },
  runtime: { name: "widget", baseUrl: "http://localhost:3000", readinessPath: "/", startCommand: "node server.js" },
};

const buildResult: BuildResult = {
  resolvedCommitSha: "a".repeat(40),
  imageName: "ghcr.io/acme/widget",
  imageDigest: `sha256:${"a".repeat(64)}`,
  snapshotId: "snap-widget",
  dockerfileText: "FROM node:20\nCMD node server.js",
  buildLog: "#1 building\n#2 done",
  buildMarker: "b".repeat(40),
  buildRecipeDigest: `sha256:${"c".repeat(64)}`,
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
    agentClient: fakeAgentClient(null),
    classify: async () => widgetPlan,
    // Default the sandboxability review to "unsure" so a not-flattenable repo falls through to the
    // build agent, the behaviour these tests exercise. Tests of the review's own routing override it.
    runSandboxabilityReview: async () => ({ verdict: "unsure", reason: "" }),
    resolveCommit: async () => "a".repeat(40),
    provision: async () => ({ sandboxId: "sbx-verify", appPort: 3000 }),
    teardown: async () => {},
    leaseSeconds: 60,
    ...over,
  };
}

/** Drive the row from a fresh enqueue through classify and build to PENDING_MANIFEST. */
async function toManifest(worker: typeof import("./worker"), over: Partial<OnboardDeps> = {}) {
  await worker.onboardOnce("w1", deps(over)); // PENDING_PLAN -> PENDING_BUILD
  await worker.onboardOnce("w1", deps(over)); // PENDING_BUILD -> PENDING_MANIFEST
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

test("classify then build stores the outputs and advances to the manifest step", async () => {
  const repoId = await connectedRepo("acme/widget");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/widget", sourceRef: "https://x/widget.git", resolvedCommitSha: "a".repeat(40) });

  await worker.onboardOnce("w1", deps({})); // PENDING_PLAN -> PENDING_BUILD
  assert.equal(await stateOf(repoId), "PENDING_BUILD");
  await worker.onboardOnce("w1", deps({})); // PENDING_BUILD -> PENDING_MANIFEST

  assert.equal(await stateOf(repoId), "PENDING_MANIFEST");
  const [row] = await dbm.db
    .select({
      imageDigest: dbm.targetOnboarding.imageDigest,
      buildRecipeDigest: dbm.targetOnboarding.buildRecipeDigest,
      resolvedCommitSha: dbm.targetOnboarding.resolvedCommitSha,
      dockerfileText: dbm.targetOnboarding.dockerfileText,
      buildPlan: dbm.targetOnboarding.buildPlan,
    })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));
  assert.equal(row.imageDigest, buildResult.imageDigest);
  assert.equal(row.buildRecipeDigest, buildResult.buildRecipeDigest);
  assert.equal(row.resolvedCommitSha, buildResult.resolvedCommitSha);
  assert.match(row.dockerfileText ?? "", /FROM node:20/);
  assert.equal((row.buildPlan as { strategy?: string }).strategy, "dockerfile");
});

test("a repo the classifier cannot flatten lands in UNSUPPORTED, no build", async () => {
  const repoId = await connectedRepo("acme/multi");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/multi", sourceRef: "https://x/multi.git", resolvedCommitSha: "a".repeat(40) });

  let built = false;
  await worker.onboardOnce(
    "w1",
    deps({
      classify: async () => ({ strategy: "not-flattenable", ecosystem: "node", reason: "two app services" }),
      // The agent runs (rung 2) but converges on nothing, so the deterministic reason stands.
      runOnboardingAgent: async () => {},
      buildDriver: { async build() { built = true; return buildResult; } },
    }),
  );

  assert.equal(await stateOf(repoId), "UNSUPPORTED");
  assert.equal(built, false, "an unsupported repo is never built");
  // UNSUPPORTED is terminal: a further claim does not pick it up.
  await worker.onboardOnce("w1", deps({}));
  assert.equal(await stateOf(repoId), "UNSUPPORTED");
});

test("a sandboxability review of 'no' goes straight to UNSUPPORTED, skipping the build agent", async () => {
  const repoId = await connectedRepo("acme/microservices");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/microservices", sourceRef: "https://x/microservices.git", resolvedCommitSha: "a".repeat(40) });

  let agentRan = false;
  let built = false;
  await worker.onboardOnce(
    "w1",
    deps({
      classify: async () => ({ strategy: "not-flattenable", ecosystem: "node", reason: "no Dockerfile" }),
      runSandboxabilityReview: async () => ({ verdict: "no", reason: "compose declares three interdependent services" }),
      runOnboardingAgent: async () => { agentRan = true; },
      buildDriver: { async build() { built = true; return buildResult; } },
    }),
  );

  assert.equal(await stateOf(repoId), "UNSUPPORTED");
  assert.equal(agentRan, false, "a 'no' verdict never runs the build agent");
  assert.equal(built, false, "a 'no' verdict never builds");
  const [row] = await dbm.db
    .select({ buildPlan: dbm.targetOnboarding.buildPlan })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));
  assert.equal((row.buildPlan as { reason?: string }).reason, "compose declares three interdependent services");
});

test("a sandboxability review of 'yes' hands off to the build agent", async () => {
  const repoId = await connectedRepo("acme/reviewyes");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/reviewyes", sourceRef: "https://x/reviewyes.git", resolvedCommitSha: "a".repeat(40) });

  let agentRan = false;
  await worker.onboardOnce(
    "w1",
    deps({
      classify: async () => ({ strategy: "not-flattenable", ecosystem: "node", reason: "no Dockerfile" }),
      runSandboxabilityReview: async () => ({ verdict: "yes", reason: "single self-contained Express app" }),
      runOnboardingAgent: async ({ onboardingId }) => {
        agentRan = true;
        await dbm.db
          .update(dbm.targetOnboarding)
          .set({
            buildPlan: {
              strategy: "agent-authored",
              ecosystem: "node",
              dockerfileText: "FROM node:20-slim\n",
              buildContext: ".",
              seed: { kind: "none" },
              runtime: { name: "reviewyes", baseUrl: "http://localhost:3000", readinessPath: "/" },
            },
          })
          .where(dbm.eq(dbm.targetOnboarding.id, onboardingId));
      },
    }),
  );

  assert.equal(agentRan, true, "a 'yes' verdict runs the build agent");
  assert.equal(await stateOf(repoId), "PENDING_BUILD");
});

test("the agent rung commits an agent-authored plan and the row goes to build", async () => {
  const repoId = await connectedRepo("acme/nodockerfile");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/nodockerfile", sourceRef: "https://x/nodockerfile.git", resolvedCommitSha: "a".repeat(40) });

  let built = false;
  const overrides: Partial<OnboardDeps> = {
    // The deterministic classifier cannot flatten a repo with no Dockerfile.
    classify: async () => ({ strategy: "not-flattenable", ecosystem: "node", reason: "no Dockerfile" }),
    // The agent stands it up: its commit_target_image writes an agent-authored plan onto the row.
    runOnboardingAgent: async ({ onboardingId }) => {
      await dbm.db
        .update(dbm.targetOnboarding)
        .set({
          buildPlan: {
            strategy: "agent-authored",
            ecosystem: "node",
            dockerfileText: 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["node","server.js"]\n',
            buildContext: ".",
            seed: { kind: "none" },
            runtime: { name: "nodockerfile", baseUrl: "http://localhost:3000", readinessPath: "/" },
          },
        })
        .where(dbm.eq(dbm.targetOnboarding.id, onboardingId));
    },
    buildDriver: { async build() { built = true; return buildResult; } },
  };

  await worker.onboardOnce("w1", deps(overrides)); // PENDING_PLAN -> (agent) -> PENDING_BUILD
  assert.equal(await stateOf(repoId), "PENDING_BUILD");
  const [row] = await dbm.db
    .select({ buildPlan: dbm.targetOnboarding.buildPlan })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));
  assert.equal((row.buildPlan as { strategy?: string }).strategy, "agent-authored");

  await worker.onboardOnce("w1", deps(overrides)); // PENDING_BUILD -> build -> PENDING_MANIFEST
  assert.equal(built, true, "the agent-authored plan is built like any other");
  assert.equal(await stateOf(repoId), "PENDING_MANIFEST");
});

test("the agent rung can declare a repo unsandboxable", async () => {
  const repoId = await connectedRepo("acme/microservices");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/microservices", sourceRef: "https://x/microservices.git", resolvedCommitSha: "a".repeat(40) });

  let built = false;
  await worker.onboardOnce(
    "w1",
    deps({
      classify: async () => ({ strategy: "not-flattenable", ecosystem: "node", reason: "no Dockerfile" }),
      // mark_unsandboxable writes a fresh not-flattenable reason onto the row.
      runOnboardingAgent: async ({ onboardingId }) => {
        await dbm.db
          .update(dbm.targetOnboarding)
          .set({ buildPlan: { strategy: "not-flattenable", ecosystem: "node", reason: "needs three services that talk to each other" } })
          .where(dbm.eq(dbm.targetOnboarding.id, onboardingId));
      },
      buildDriver: { async build() { built = true; return buildResult; } },
    }),
  );

  assert.equal(await stateOf(repoId), "UNSUPPORTED");
  assert.equal(built, false);
});

test("the manifest is derived from the build plan and reaches the human gate", async () => {
  const repoId = await connectedRepo("acme/widget");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/widget", sourceRef: "https://x/widget.git", resolvedCommitSha: "a".repeat(40) });

  await toManifest(worker);
  await worker.onboardOnce("w1", deps({})); // PENDING_MANIFEST -> AWAITING_APPROVAL

  assert.equal(await stateOf(repoId), "AWAITING_APPROVAL");
  const [row] = await dbm.db
    .select({ manifest: dbm.targetOnboarding.proposedManifest })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));
  const manifest = row.manifest as { name?: string; imageName?: string };
  assert.equal(manifest.name, "widget");
  // imageName comes from the build, not the plan.
  assert.equal(manifest.imageName, "ghcr.io/acme/widget");
});

test("the worker never advances a row out of AWAITING_APPROVAL on its own", async () => {
  const repoId = await connectedRepo("acme/widget");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/widget", sourceRef: "https://x/widget.git", resolvedCommitSha: "a".repeat(40) });
  await toManifest(worker);
  await worker.onboardOnce("w1", deps({}));
  assert.equal(await stateOf(repoId), "AWAITING_APPROVAL");

  // Repeated claims cannot pick it up: it stays put until a human moves it to APPROVED.
  await worker.onboardOnce("w1", deps({}));
  assert.equal(await stateOf(repoId), "AWAITING_APPROVAL");
});

test("an approved row verifies offline and writes the TargetProfile", async () => {
  const repoId = await connectedRepo("acme/widget");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/widget", sourceRef: "https://x/widget.git", resolvedCommitSha: "a".repeat(40) });
  await toManifest(worker);
  await worker.onboardOnce("w1", deps({})); // -> AWAITING_APPROVAL

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

test("an approved compose mesh verifies every service and pins the service graph", async () => {
  const repoId = await connectedRepo("acme/mesh-widget");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/mesh-widget", sourceRef: "https://x/mesh-widget.git", resolvedCommitSha: "a".repeat(40) });

  const meshPlan: BuildPlan = {
    strategy: "compose-mesh",
    ecosystem: "node",
    composePath: "docker-compose.yml",
    appService: "web",
    services: [
      { service: "web", role: "app", port: 3000, build: { context: "." }, peers: ["db"] },
      { service: "db", role: "dependency", port: 5432, image: "postgres:16" },
    ],
    seed: { kind: "none" },
    runtime: { name: "mesh-widget", baseUrl: "http://localhost:3000", readinessPath: "/" },
  };
  const services = [
    {
      service: "web",
      role: "app" as const,
      imageName: "ghcr.io/acme/mesh-widget-web",
      imageDigest: `sha256:${"d".repeat(64)}`,
      snapshotId: "snap-web",
      snapshotImageRef: "ghcr.io/acme/mesh-widget-web:bountydesk-onboarding",
      port: 3000,
      buildMarker: "e".repeat(40),
      startCommand: "node server.js",
      peers: ["db"],
    },
    {
      service: "db",
      role: "dependency" as const,
      imageName: "ghcr.io/acme/mesh-widget-db",
      imageDigest: `sha256:${"f".repeat(64)}`,
      snapshotId: "snap-db",
      snapshotImageRef: "ghcr.io/acme/mesh-widget-db:bountydesk-onboarding",
      port: 5432,
      startCommand: "postgres",
    },
  ];

  await worker.onboardOnce("w1", deps({ classify: async () => meshPlan, buildDriver: fakeBuildDriver({ ...buildResult, imageName: services[0].imageName, services: services as BuildResult["services"] }) }));
  await worker.onboardOnce("w1", deps({ classify: async () => meshPlan, buildDriver: fakeBuildDriver({ ...buildResult, imageName: services[0].imageName, services: services as BuildResult["services"] }) }));
  await worker.onboardOnce("w1", deps({ classify: async () => meshPlan, buildDriver: fakeBuildDriver({ ...buildResult, imageName: services[0].imageName, services: services as BuildResult["services"] }) }));
  assert.equal(await stateOf(repoId), "AWAITING_APPROVAL");

  await dbm.db
    .update(dbm.targetOnboarding)
    .set({ state: "APPROVED", approvedBy: "octocat", approvedAt: new Date() })
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));

  let verifiedServices: string[] = [];
  await worker.onboardOnce(
    "w1",
    deps({
      classify: async () => meshPlan,
      buildDriver: fakeBuildDriver({ ...buildResult, imageName: services[0].imageName, services: services as BuildResult["services"] }),
      provisionMesh: async (authorization) => {
        verifiedServices = authorization.services.map((service) => service.service);
        return { sandboxId: "sb-web", appPort: 3000, sandboxIds: ["sb-web", "sb-db"] };
      },
      teardown: async () => {},
    }),
  );

  assert.deepEqual(verifiedServices, ["web", "db"]);
  assert.equal(await stateOf(repoId), "CONFIGURED");
  const [profile] = await dbm.db
    .select({ config: dbm.targetProfile.config })
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.name, "mesh-widget"));
  assert.ok(profile);
  assert.deepEqual(
    (profile.config as { services: Array<{ service: string }> }).services.map((service) => service.service),
    ["web", "db"],
  );
});

test("a failed offline verify leaves the row unwritten", async () => {
  const repoId = await connectedRepo("acme/widget");
  await drain();
  await queue.enqueue({ repoId, repoFullName: "acme/widget", sourceRef: "https://x/widget.git", resolvedCommitSha: "a".repeat(40) });
  await toManifest(worker);
  await worker.onboardOnce("w1", deps({})); // -> AWAITING_APPROVAL
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

test("a mesh verify tears down every sandbox even when one delete fails", async () => {
  const repoId = await connectedRepo("acme/mesh-teardown");
  await drain();
  await queue.enqueue({
    repoId,
    repoFullName: "acme/mesh-teardown",
    sourceRef: "https://x/mesh-teardown.git",
    resolvedCommitSha: "a".repeat(40),
  });

  const meshPlan: BuildPlan = {
    strategy: "compose-mesh",
    ecosystem: "node",
    composePath: "docker-compose.yml",
    appService: "web",
    services: [
      { service: "web", role: "app", port: 3000, build: { context: "." }, peers: ["db"] },
      { service: "db", role: "dependency", port: 5432, image: "postgres:16" },
    ],
    seed: { kind: "none" },
    runtime: { name: "mesh-teardown", baseUrl: "http://localhost:3000", readinessPath: "/" },
  };
  const services = [
    {
      service: "web",
      role: "app" as const,
      imageName: "ghcr.io/acme/mesh-teardown-web",
      imageDigest: `sha256:${"d".repeat(64)}`,
      snapshotId: "snap-web",
      snapshotImageRef: "ghcr.io/acme/mesh-teardown-web:bountydesk-onboarding",
      port: 3000,
      buildMarker: "e".repeat(40),
      startCommand: "node server.js",
      peers: ["db"],
    },
    {
      service: "db",
      role: "dependency" as const,
      imageName: "ghcr.io/acme/mesh-teardown-db",
      imageDigest: `sha256:${"f".repeat(64)}`,
      snapshotId: "snap-db",
      snapshotImageRef: "ghcr.io/acme/mesh-teardown-db:bountydesk-onboarding",
      port: 5432,
      startCommand: "postgres",
    },
  ];
  const driver = fakeBuildDriver({
    ...buildResult,
    imageName: services[0].imageName,
    services: services as BuildResult["services"],
  });
  const overrides: Partial<OnboardDeps> = {
    classify: async () => meshPlan,
    buildDriver: driver,
    provisionMesh: async () => ({ sandboxId: "sb-web", appPort: 3000, sandboxIds: ["sb-web", "sb-db"] }),
  };

  await worker.onboardOnce("w1", deps(overrides));
  await worker.onboardOnce("w1", deps(overrides));
  await worker.onboardOnce("w1", deps(overrides));
  await dbm.db
    .update(dbm.targetOnboarding)
    .set({ state: "APPROVED" })
    .where(dbm.eq(dbm.targetOnboarding.repoId, repoId));

  const attempted: string[] = [];
  await worker.onboardOnce(
    "w1",
    deps({
      ...overrides,
      teardown: async (id: string) => {
        attempted.push(id);
        // The app delete fails; the dependency delete must still be attempted.
        if (id === "sb-web") throw new Error("daytona delete 500");
      },
    }),
  );

  assert.deepEqual([...attempted].sort(), ["sb-db", "sb-web"], "every sandbox is attempted");
  assert.equal(await stateOf(repoId), "APPROVED", "an orphaned sandbox must not be recorded as configured");
});
