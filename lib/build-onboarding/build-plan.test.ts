import assert from "node:assert/strict";
import test from "node:test";

import { parseBuildPlan, type BuildPlan } from "./build-plan";

const runtime = {
  name: "demo",
  baseUrl: "http://localhost:8080",
  readinessPath: "/",
};

test("a dockerfile plan parses with defaults for path and context", () => {
  const plan = parseBuildPlan({
    strategy: "dockerfile",
    ecosystem: "python",
    runtime,
  });
  assert.equal(plan.strategy, "dockerfile");
  if (plan.strategy !== "dockerfile") throw new Error("narrowing");
  assert.equal(plan.dockerfilePath, "Dockerfile");
  assert.equal(plan.buildContext, ".");
  assert.deepEqual(plan.seed, { kind: "none" });
  assert.equal(plan.runtime?.baseUrl, "http://localhost:8080");
});

test("an image plan keeps the pinned-later base reference", () => {
  const plan = parseBuildPlan({
    strategy: "image",
    ecosystem: "none",
    baseImage: "vulnerables/web-dvwa",
    runtime,
  });
  if (plan.strategy !== "image") throw new Error("narrowing");
  assert.equal(plan.baseImage, "vulnerables/web-dvwa");
});

test("a compose-synth plan carries the app service, datastores and an http seed", () => {
  const plan = parseBuildPlan({
    strategy: "compose-synth",
    ecosystem: "php",
    composePath: "compose.yml",
    appService: "dvwa",
    datastores: [{ service: "db", engine: "mariadb", dbName: "dvwa", user: "dvwa", password: "p" }],
    seed: { kind: "http", method: "GET", path: "/setup.php" },
    runtime: { name: "dvwa", baseUrl: "http://localhost:80", readinessPath: "/login.php", warmupSeconds: 45 },
    extraEgressHosts: ["deb.debian.org"],
  });
  if (plan.strategy !== "compose-synth") throw new Error("narrowing");
  assert.equal(plan.appService, "dvwa");
  assert.equal(plan.datastores[0]?.engine, "mariadb");
  assert.deepEqual(plan.seed, { kind: "http", method: "GET", path: "/setup.php" });
  assert.equal(plan.runtime?.warmupSeconds, 45);
  assert.deepEqual(plan.extraEgressHosts, ["deb.debian.org"]);
});

test("not-flattenable needs a reason and carries no runtime", () => {
  const plan = parseBuildPlan({
    strategy: "not-flattenable",
    ecosystem: "node",
    reason: "two app services expose HTTP; cannot flatten to one image",
  });
  if (plan.strategy !== "not-flattenable") throw new Error("narrowing");
  assert.match(plan.reason, /two app services/);
  assert.equal(plan.runtime, undefined);
});

test("the start-command guard rejects a docker-host command, same as the manifest", () => {
  assert.throws(
    () =>
      parseBuildPlan({
        strategy: "dockerfile",
        ecosystem: "none",
        runtime: { ...runtime, startCommand: "docker compose up" },
      }),
    /not a docker or podman host command/,
  );
});

test("a non-loopback runtime baseUrl is rejected", () => {
  assert.throws(
    () =>
      parseBuildPlan({
        strategy: "dockerfile",
        ecosystem: "none",
        runtime: { name: "demo", baseUrl: "http://example.com", readinessPath: "/" },
      }),
    /must point at loopback/,
  );
});

test("scope rules may only allow localhost", () => {
  assert.throws(
    () =>
      parseBuildPlan({
        strategy: "dockerfile",
        ecosystem: "none",
        runtime: { ...runtime, scopeRules: [{ allow: "example.com" }] },
      }),
    /may only allow localhost/,
  );
});

test("a build context that escapes the repo is rejected", () => {
  assert.throws(
    () =>
      parseBuildPlan({
        strategy: "dockerfile",
        ecosystem: "none",
        buildContext: "../etc",
        runtime,
      }),
    /repo-relative path with no traversal/,
  );
});

test("an unknown datastore engine makes the plan invalid", () => {
  assert.throws(
    () =>
      parseBuildPlan({
        strategy: "compose-synth",
        ecosystem: "php",
        composePath: "compose.yml",
        appService: "app",
        datastores: [{ service: "db", engine: "cassandra" }],
        runtime,
      }),
    /engine must be one of/,
  );
});

test("an unknown strategy is rejected", () => {
  assert.throws(() => parseBuildPlan({ strategy: "kubernetes", ecosystem: "none" }), /strategy must be one of/);
});

test("buildArgs must be single-line strings under valid env keys", () => {
  const plan = parseBuildPlan({
    strategy: "dockerfile",
    ecosystem: "node",
    buildArgs: { NODE_ENV: "production" },
    runtime,
  }) as Extract<BuildPlan, { strategy: "dockerfile" }>;
  assert.deepEqual(plan.buildArgs, { NODE_ENV: "production" });
  assert.throws(
    () =>
      parseBuildPlan({
        strategy: "dockerfile",
        ecosystem: "node",
        buildArgs: { "bad key": "x" },
        runtime,
      }),
    /is not a valid env name/,
  );
});
