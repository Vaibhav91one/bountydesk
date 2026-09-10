import assert from "node:assert/strict";
import test from "node:test";

import { parseBuildPlan } from "./build-plan";
import { meshBuildPlan } from "./mesh-build-plan";

test("meshBuildPlan creates isolated image and snapshot identities per service", () => {
  const plan = parseBuildPlan({
    strategy: "compose-mesh",
    ecosystem: "python",
    composePath: "docker-compose.yml",
    appService: "web",
    services: [
      { service: "web", role: "app", port: 5000, build: { context: "." }, peers: ["db"] },
      { service: "db", role: "dependency", port: 5432, image: "postgres:13" },
    ],
    runtime: { name: "web", baseUrl: "http://localhost:5000", readinessPath: "/" },
  });
  if (plan.strategy !== "compose-mesh") throw new Error("narrowing");

  const result = meshBuildPlan(plan, {
    ghcrNamespace: "ghcr.io/example",
    slug: "owner-web",
    buildTag: "bountydesk-deadbeef",
  });

  assert.deepEqual(result.map((service) => service.service), ["web", "db"]);
  assert.equal(result[0]?.imageTag, "ghcr.io/example/owner-web-web:bountydesk-deadbeef");
  assert.equal(result[0]?.snapshotName, "onboarding-owner-web-web");
  assert.equal(result[0]?.requiresBuildMarker, true);
  assert.equal(result[1]?.image, "postgres:13");
  assert.equal(result[1]?.requiresBuildMarker, false);
  assert.deepEqual(result[0]?.peers, ["db"]);
});
