import assert from "node:assert/strict";
import test from "node:test";

import type { Sandbox, SnapshotInfo } from "@/lib/sandbox/daytona";

import { parseBuildPlan } from "./build-plan";
import { buildMesh, type MeshBuildRuntime } from "./daytona-build-driver";
import { createRegistry } from "./registry";

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

const PUSH_TOKEN = "push-token-secret";
const CTX = {
  registry: createRegistry({ host: "ghcr.io", user: "bountydesk", namespace: "ghcr.io/example", pushToken: PUSH_TOKEN }),
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

  const tokenUses = commands.filter((entry) => entry.command.includes(PUSH_TOKEN));
  assert.ok(tokenUses.length > 0, "the push path must log in with the token");
  for (const entry of tokenUses) {
    assert.match(entry.command, /docker login 'ghcr\.io'/);
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

test("buildMesh starts a service with its compose command, quoted for sh -c (NodeGoat)", async () => {
  const script =
    "until nc -z -w 2 mongo 27017 && echo 'mongo is ready for connections' && node artifacts/db-reset.js && npm start; do sleep 2; done";
  const plan = parseBuildPlan({
    strategy: "compose-mesh",
    ecosystem: "node",
    composePath: "docker-compose.yml",
    appService: "web",
    services: [
      { service: "web", role: "app", port: 4000, build: { context: "." }, peers: ["mongo"], command: ["sh", "-c", script] },
      { service: "mongo", role: "dependency", port: 27017, image: "mongo:4.4", command: ["mongod", "--bind_ip_all"] },
    ],
    runtime: { name: "nodegoat", baseUrl: "http://localhost:4000", readinessPath: "/" },
  });
  if (plan.strategy !== "compose-mesh") throw new Error("narrowing");
  const { runtime } = makeRuntime();
  const result = await buildMesh(SANDBOX, plan, { ...CTX, runtime });
  const web = result.services!.find((service) => service.service === "web")!;
  const mongo = result.services!.find((service) => service.service === "mongo")!;

  // The image's ENTRYPOINT stays, the compose command replaces its CMD.
  assert.equal(
    web.startCommand,
    `cd /app && /usr/local/bin/docker-entrypoint.sh sh -c 'until nc -z -w 2 mongo 27017 && echo '\\''mongo is ready for connections'\\'' && node artifacts/db-reset.js && npm start; do sleep 2; done'`,
  );
  assert.equal(mongo.startCommand, "cd /app && /usr/local/bin/docker-entrypoint.sh mongod --bind_ip_all");

  // The provisioner runs the line with sh -c; the shell must hand the script to the inner sh whole.
  const { execFileSync } = await import("node:child_process");
  const argv = execFileSync("sh", ["-c", `printf '%s\\n' ${web.startCommand.replace(/^cd \/app && /, "")}`], {
    encoding: "utf8",
  });
  assert.equal(argv, `/usr/local/bin/docker-entrypoint.sh\nsh\n-c\n${script}\n`);
});

test("meshStartCommand applies Compose's entrypoint and command override rules", async () => {
  const { meshStartCommand } = await import("./daytona-build-driver");
  const image = { entrypoint: ["docker-entrypoint.sh"], cmd: ["node"], workdir: "/home/node/app" };
  assert.equal(meshStartCommand(image), "cd /home/node/app && docker-entrypoint.sh node");
  assert.equal(meshStartCommand(image, { command: ["npm", "start"] }), "cd /home/node/app && docker-entrypoint.sh npm start");
  // A set entrypoint drops the image's CMD unless a command is given too.
  assert.equal(meshStartCommand(image, { entrypoint: ["/run.sh"] }), "cd /home/node/app && /run.sh");
  assert.equal(meshStartCommand(image, { entrypoint: ["/run.sh"], command: ["--fast"] }), "cd /home/node/app && /run.sh --fast");
  // An empty entrypoint clears it; an empty command clears CMD.
  assert.equal(meshStartCommand(image, { entrypoint: [], command: ["node", "server.js"] }), "cd /home/node/app && node server.js");
  assert.equal(meshStartCommand(image, { command: [] }), "cd /home/node/app && docker-entrypoint.sh");
  assert.equal(meshStartCommand({ entrypoint: [], cmd: [], workdir: "/" }), undefined);
  // A working directory with a space is quoted too.
  assert.equal(meshStartCommand({ entrypoint: [], cmd: ["./start.sh"], workdir: "/my app" }), "cd '/my app' && ./start.sh");
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

