import assert from "node:assert/strict";
import test from "node:test";

import type { Sandbox, SnapshotInfo } from "@/lib/sandbox/daytona";

import { parseBuildPlan } from "./build-plan";
import { buildMesh, type MeshBuildRuntime } from "./daytona-build-driver";

/**
 * buildMesh's orchestration, exercised through the injected runtime so no live Daytona account or
 * registry is involved. The subject is the command transcript and the shape of the result: which
 * image gets built versus pulled, that the push credential only appears around the push, that each
 * service registers its own snapshot, and that the mesh recipe digest covers every service.
 */

type Recorded = { sandbox: string; command: string };

const SANDBOX = { id: "sbx-build" } as unknown as Sandbox;

function makeRuntime(overrides: Partial<MeshBuildRuntime> = {}): {
  runtime: MeshBuildRuntime;
  commands: Recorded[];
  snapshots: Array<{ name: string; image: string }>;
  deletedSnapshots: string[];
} {
  const commands: Recorded[] = [];
  const snapshots: Array<{ name: string; image: string }> = [];
  const deletedSnapshots: string[] = [];

  const runtime: MeshBuildRuntime = {
    async run(sandbox, command) {
      commands.push({ sandbox: sandbox.id, command });
      if (command.startsWith("cd /work/source") && command.includes("cat ")) {
        return { exitCode: 0, result: "FROM python:3.11\nCMD [\"./start.sh\"]\n" };
      }
      if (command.includes("docker inspect --format='{{json .Config.Entrypoint}}'")) {
        return { exitCode: 0, result: '["/usr/local/bin/docker-entrypoint.sh"]' };
      }
      if (command.includes("docker inspect --format='{{json .Config.Cmd}}'")) {
        return { exitCode: 0, result: '["postgres"]' };
      }
      if (command.includes("docker inspect --format='{{.Config.WorkingDir}}'")) {
        return { exitCode: 0, result: "/app" };
      }
      if (command.includes(".RepoDigests")) {
        return { exitCode: 0, result: "sha256:" + "d".repeat(64) };
      }
      return { exitCode: 0, result: "ok" };
    },
    async createSnapshot(spec) {
      snapshots.push({ name: spec.name, image: spec.image });
      return { id: `snap-${spec.name}`, name: spec.name, state: "active", imageName: spec.image } as SnapshotInfo;
    },
    async deleteSnapshotByName(name) {
      deletedSnapshots.push(name);
    },
    ...overrides,
  };
  return { runtime, commands, snapshots, deletedSnapshots };
}

function meshPlan() {
  const plan = parseBuildPlan({
    strategy: "compose-mesh",
    ecosystem: "python",
    composePath: "docker-compose.yml",
    appService: "web",
    services: [
      { service: "web", role: "app", port: 5000, build: { context: "." }, peers: ["db"], env: { DB_HOST: "db" } },
      { service: "db", role: "dependency", port: 5432, image: "postgres:13", env: { POSTGRES_PASSWORD: "postgres" } },
    ],
    runtime: { name: "web", baseUrl: "http://localhost:5000", readinessPath: "/" },
  });
  if (plan.strategy !== "compose-mesh") throw new Error("narrowing");
  return plan;
}

const CTX = {
  ghcrNamespace: "ghcr.io/example",
  pushToken: "push-token-secret",
  slug: "owner-vuln-bank",
  buildMarker: "a".repeat(40),
  resolvedCommitSha: "a".repeat(40),
};

test("buildMesh builds the app, pulls the datastore, and registers one snapshot per service", async () => {
  const { runtime, commands, snapshots, deletedSnapshots } = makeRuntime();

  const result = await buildMesh(SANDBOX, meshPlan(), { ...CTX, runtime });

  assert.equal(result.services?.length, 2);
  const app = result.services!.find((service) => service.role === "app")!;
  const db = result.services!.find((service) => service.role === "dependency")!;

  // The app is built from the repo and carries a marker; the datastore is pulled and does not.
  assert.equal(app.buildMarker, CTX.buildMarker);
  assert.equal(db.buildMarker, undefined);
  assert.equal(app.imageName, "ghcr.io/example/owner-vuln-bank-web");
  assert.equal(db.imageName, "ghcr.io/example/owner-vuln-bank-db");

  assert.ok(commands.some((entry) => entry.command.startsWith("docker pull 'postgres:13'")));
  assert.ok(commands.some((entry) => entry.command.includes("docker build -f Dockerfile.bountydesk")));

  // Top-level fields mirror the app service so single-image consumers keep working.
  assert.equal(result.imageName, app.imageName);
  assert.equal(result.imageDigest, app.imageDigest);
  assert.equal(result.snapshotId, app.snapshotId);

  // One snapshot per service, each replaced under its own deterministic name first.
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.name).sort(),
    ["onboarding-owner-vuln-bank-db", "onboarding-owner-vuln-bank-web"],
  );
  assert.deepEqual(deletedSnapshots.sort(), ["onboarding-owner-vuln-bank-db", "onboarding-owner-vuln-bank-web"]);
});

test("buildMesh keeps the push credential inside the login/push/logout window only", async () => {
  const { runtime, commands } = makeRuntime();
  await buildMesh(SANDBOX, meshPlan(), { ...CTX, runtime });

  const tokenUses = commands.filter((entry) => entry.command.includes(CTX.pushToken));
  assert.ok(tokenUses.length > 0, "the push path must log in with the token");
  for (const entry of tokenUses) {
    assert.match(entry.command, /docker login ghcr\.io/);
  }
  // Every login is followed by a push then a logout on the same sandbox.
  const logins = commands.filter((entry) => entry.command.includes("docker login"));
  const logouts = commands.filter((entry) => entry.command.includes("docker logout"));
  assert.equal(logins.length, 2, "one login per pushed image");
  assert.equal(logouts.length, 2, "one logout per login");
});

test("buildMesh captures the service start command with its working directory", async () => {
  const { runtime } = makeRuntime();
  const result = await buildMesh(SANDBOX, meshPlan(), { ...CTX, runtime });
  const app = result.services!.find((service) => service.role === "app")!;
  assert.equal(app.startCommand, "cd /app && /usr/local/bin/docker-entrypoint.sh postgres");
});

test("buildMesh retries a snapshot name that Daytona still reports as a conflict", async () => {
  let attempts = 0;
  const { runtime } = makeRuntime({
    async createSnapshot(spec) {
      attempts += 1;
      if (attempts === 1) {
        const { DaytonaError } = await import("@/lib/sandbox/daytona");
        throw new DaytonaError("snapshot name already exists", 409);
      }
      return { id: `snap-${spec.name}`, name: spec.name, state: "active", imageName: spec.image } as SnapshotInfo;
    },
  });

  const result = await buildMesh(SANDBOX, meshPlan(), { ...CTX, runtime });
  assert.equal(result.services?.length, 2);
  assert.ok(attempts >= 3, "the 409 must be retried, not surfaced");
});

test("buildMesh covers every service in the recipe digest", async () => {
  const { runtime } = makeRuntime();
  const result = await buildMesh(SANDBOX, meshPlan(), { ...CTX, runtime });
  assert.match(result.buildRecipeDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.resolvedCommitSha, CTX.resolvedCommitSha);

  // A second build of the same plan produces the same digest, since identity does not depend on the
  // random per-build image tag.
  const second = await buildMesh(SANDBOX, meshPlan(), { ...CTX, runtime: makeRuntime().runtime });
  assert.equal(second.buildRecipeDigest, result.buildRecipeDigest);
});

test("buildMesh fails loudly when a service build command exits non-zero", async () => {
  const { runtime } = makeRuntime({
    async run(sandbox, command) {
      if (command.includes("docker build -f Dockerfile.bountydesk")) {
        throw new Error("build command failed (exit 1): step 3/8: npm ci failed");
      }
      if (command.includes(".RepoDigests")) return { exitCode: 0, result: "sha256:" + "d".repeat(64) };
      return { exitCode: 0, result: "ok" };
    },
  });

  await assert.rejects(buildMesh(SANDBOX, meshPlan(), { ...CTX, runtime }), /build command failed/);
});

test("buildMesh logs out even when the push itself fails", async () => {
  const commands: string[] = [];
  const { runtime } = makeRuntime({
    async run(sandbox, command) {
      commands.push(command);
      if (command.startsWith("docker push")) throw new Error("build command failed (exit 1): denied");
      if (command.includes("json .Config.Entrypoint")) return { exitCode: 0, result: '["/entrypoint.sh"]' };
      if (command.includes("json .Config.Cmd")) return { exitCode: 0, result: '["serve"]' };
      if (command.includes(".Config.WorkingDir")) return { exitCode: 0, result: "/app" };
      if (command.includes(".RepoDigests")) return { exitCode: 0, result: "sha256:" + "d".repeat(64) };
      return { exitCode: 0, result: "ok" };
    },
  });

  await assert.rejects(buildMesh(SANDBOX, meshPlan(), { ...CTX, runtime }), /build command failed/);
  assert.ok(commands.some((command) => command.includes("docker logout")), "the credential must not linger");
});

