import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { parseBuildPlan } from "@/lib/build-onboarding/build-plan";

/**
 * The build tools' capability boundary against a real Postgres, with no Daytona: every test that
 * would open a sandbox stops before the provider call, so what is proven here is token resolution,
 * cross-row isolation, and plan persistence. The dispatcher never advances the onboarding state
 * machine; the worker holds the lease and does that.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let build: typeof import("./build");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("mcp_build");
  dbm = await import("@/lib/db");
  build = await import("./build");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function seedOnboarding(token: string): Promise<string> {
  seq += 1;
  const [row] = await dbm.db
    .insert(dbm.targetOnboarding)
    .values({
      repoId: 910_000 + seq,
      repoFullName: `acme/tool-${seq}`,
      sourceRef: `https://github.com/acme/tool-${seq}.git`,
      resolvedCommitSha: "a".repeat(40),
      state: "PENDING_PLAN",
      agentCapabilityToken: token,
    })
    .returning({ id: dbm.targetOnboarding.id });
  return row.id;
}

async function planOf(id: string): Promise<unknown> {
  const [row] = await dbm.db
    .select({ buildPlan: dbm.targetOnboarding.buildPlan, state: dbm.targetOnboarding.state })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.id, id));
  return row;
}

test("every tool refuses an unknown capability before any provider or row work", async () => {
  for (const result of [
    await build.openBuildSandbox("not-a-real-token"),
    await build.runBuildCommand("not-a-real-token", "ls"),
    await build.commitTargetImage({
      capability: "not-a-real-token",
      dockerfileText: "FROM node:20\n",
      name: "x",
      baseUrl: "http://localhost:3000",
      readinessPath: "/",
    }),
    await build.commitComposeMesh({
      capability: "not-a-real-token",
      appService: "web",
      services: [],
      name: "x",
      baseUrl: "http://localhost:3000",
      readinessPath: "/",
    }),
    await build.markUnsandboxable("not-a-real-token", "reason"),
  ]) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /unknown capability/);
  }
});

test("a capability resolves only its own row", async () => {
  const firstToken = `token-${seq}-one`;
  const secondToken = `token-${seq}-two`;
  const first = await seedOnboarding(firstToken);
  await seedOnboarding(secondToken);

  const result = await build.commitTargetImage({
    capability: firstToken,
    dockerfileText: "FROM node:20\nCMD [\"node\",\"server.js\"]\n",
    name: "tool-a",
    baseUrl: "http://localhost:3000",
    readinessPath: "/health",
  });
  assert.equal(result.ok, true);

  const firstRow = (await planOf(first)) as { buildPlan: { runtime?: { name?: string } } };
  assert.equal(firstRow.buildPlan.runtime?.name, "tool-a");

  const all = await dbm.db.select({ id: dbm.targetOnboarding.id, buildPlan: dbm.targetOnboarding.buildPlan }).from(dbm.targetOnboarding);
  const others = all.filter((row) => row.id !== first);
  for (const row of others) {
    assert.equal(row.buildPlan, null, "another row must never be written by this token");
  }
});

test("commit_compose_mesh validates topology and persists the plan without advancing state", async () => {
  const token = `token-${seq}-mesh`;
  const id = await seedOnboarding(token);

  const bad = await build.commitComposeMesh({
    capability: token,
    appService: "web",
    services: [{ service: "web", role: "app", port: 3000 }],
    name: "mesh",
    baseUrl: "http://localhost:3000",
    readinessPath: "/",
  });
  assert.equal(bad.ok, false);

  const good = await build.commitComposeMesh({
    capability: token,
    appService: "web",
    services: [
      { service: "web", role: "app", port: 5000, build: { context: "." }, peers: ["db"] },
      { service: "db", role: "dependency", port: 5432, image: "postgres:13" },
    ],
    name: "vuln-bank",
    baseUrl: "http://localhost:5000",
    readinessPath: "/",
  });
  assert.equal(good.ok, true);

  const row = (await planOf(id)) as { buildPlan: { strategy?: string }; state: string };
  assert.equal(row.buildPlan.strategy, "compose-mesh");
  assert.equal(row.state, "PENDING_PLAN", "the tool must not move the state the worker owns");
});

// Library-level validation coverage stays provider-free. DB-backed capability and Daytona lifecycle
// tests belong beside the disposable-schema onboarding worker suite once their adapters are injected.
test("compose mesh input shape rejects a service that sets neither build nor image", () => {
  assert.throws(
    () =>
      parseBuildPlan({
        strategy: "compose-mesh",
        ecosystem: "node",
        composePath: "docker-compose.yml",
        appService: "web",
        services: [{ service: "web", role: "app", port: 3000 }],
        runtime: { name: "web", baseUrl: "http://localhost:3000", readinessPath: "/" },
      }),
    /exactly one of build or image/,
  );
});

test("compose mesh input rejects a host-model start command", () => {
  assert.throws(
    () =>
      parseBuildPlan({
        strategy: "compose-mesh",
        ecosystem: "node",
        composePath: "docker-compose.yml",
        appService: "web",
        services: [{ service: "web", role: "app", port: 3000, build: { context: "." } }],
        runtime: {
          name: "web",
          baseUrl: "http://localhost:3000",
          readinessPath: "/",
          startCommand: "docker run example",
        },
      }),
    /not a docker or podman host command/,
  );
});
