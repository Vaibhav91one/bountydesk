import assert from "node:assert/strict";
import test from "node:test";

import {
  classify,
  detectEcosystem,
  dockerfileExposePort,
  ecosystemFromDockerfile,
  parseComposeTopology,
  profileNameFromRepo,
  type SourceReader,
} from "./classify";

function reader(files: Record<string, string>): SourceReader {
  return { async readFile(path: string) { return files[path] ?? null; } };
}

const DVWA_COMPOSE = `
services:
  dvwa:
    build: .
    ports:
      - "127.0.0.1:80:80"
    depends_on: [db]
  db:
    image: mariadb:10
    environment:
      MYSQL_DATABASE: dvwa
      MYSQL_USER: dvwa
      MYSQL_PASSWORD: p@ss
`;

test("profile name comes from the repo name, lowercased", () => {
  assert.equal(profileNameFromRepo("Vaibhav91one/DVWA"), "dvwa");
  assert.equal(profileNameFromRepo("owner/My_App.v2"), "my_app.v2");
});

test("ecosystem is detected from the package manifest", async () => {
  assert.equal(await detectEcosystem(reader({ "composer.json": "{}" })), "php");
  assert.equal(await detectEcosystem(reader({ "package.json": "{}" })), "node");
  assert.equal(await detectEcosystem(reader({ "go.mod": "module x" })), "go");
  assert.equal(await detectEcosystem(reader({})), "none");
});

test("EXPOSE is read from a Dockerfile", () => {
  assert.equal(dockerfileExposePort("FROM x\nEXPOSE 65412\nCMD y"), 65412);
  assert.equal(dockerfileExposePort("FROM x"), undefined);
});

test("DVWA compose is a compose-synth plan: one app, MariaDB with its creds", () => {
  const topo = parseComposeTopology(DVWA_COMPOSE);
  assert.ok(topo.ok);
  if (!topo.ok) return;
  assert.equal(topo.appService, "dvwa");
  assert.equal(topo.appPort, 80);
  assert.equal(topo.datastores[0]?.engine, "mariadb");
  assert.equal(topo.datastores[0]?.dbName, "dvwa");
  assert.equal(topo.datastores[0]?.password, "p@ss");
});

test("classify turns DVWA into a compose-synth build plan", async () => {
  const plan = await classify(reader({ "compose.yml": DVWA_COMPOSE, "composer.json": "{}" }), "Vaibhav91one/DVWA");
  assert.equal(plan.strategy, "compose-synth");
  if (plan.strategy !== "compose-synth") return;
  assert.equal(plan.ecosystem, "php");
  assert.equal(plan.appService, "dvwa");
  assert.equal(plan.runtime?.name, "dvwa");
  assert.equal(plan.runtime?.baseUrl, "http://localhost:80");
  assert.equal(plan.datastores[0]?.engine, "mariadb");
});

test("ecosystem is inferred from a Dockerfile base image", () => {
  assert.equal(ecosystemFromDockerfile("FROM docker.io/library/php:8-apache"), "php");
  assert.equal(ecosystemFromDockerfile("FROM node:20-alpine"), "node");
  assert.equal(ecosystemFromDockerfile("FROM eclipse-temurin:21-jre"), "java");
  assert.equal(ecosystemFromDockerfile("FROM scratch"), "none");
});

test("a compose app with its language in a subdir gets its ecosystem and datastore egress from the Dockerfile", async () => {
  // No root composer.json (DVWA's is under vulnerabilities/api); only the Dockerfile FROM says PHP.
  const plan = await classify(
    reader({ "compose.yml": DVWA_COMPOSE, Dockerfile: "FROM php:8-apache\nRUN apt-get update" }),
    "Vaibhav91one/DVWA",
  );
  assert.equal(plan.strategy, "compose-synth");
  if (plan.strategy !== "compose-synth") return;
  assert.equal(plan.ecosystem, "php");
  // the MariaDB install needs Debian apt hosts regardless of the app's ecosystem
  assert.ok(plan.extraEgressHosts?.includes("deb.debian.org"), "datastore apt egress is added");
});

test("classify turns a bare Dockerfile repo into a dockerfile plan (DSVW shape)", async () => {
  const plan = await classify(reader({ Dockerfile: "FROM python:3.10-alpine\nEXPOSE 65412" }), "Vaibhav91one/DSVW");
  assert.equal(plan.strategy, "dockerfile");
  if (plan.strategy !== "dockerfile") return;
  assert.equal(plan.runtime?.baseUrl, "http://localhost:65412");
  assert.equal(plan.dockerfilePath, "Dockerfile");
});

test("a compose with two app services is not-flattenable", () => {
  const topo = parseComposeTopology(`
services:
  web:
    build: ./web
    ports: ["8080:8080"]
  api:
    build: ./api
    ports: ["9090:9090"]
  db:
    image: mariadb:10
`);
  assert.equal(topo.ok, false);
  if (topo.ok) return;
  assert.match(topo.reason, /more than one app service/);
});

test("a compose whose datastore has no recipe is not-flattenable", () => {
  const topo = parseComposeTopology(`
services:
  app:
    build: .
    ports: ["80:80"]
  store:
    image: cassandra:4
`);
  assert.equal(topo.ok, false);
  if (topo.ok) return;
  // cassandra maps to no engine, so it reads as no recognised datastore.
  assert.match(topo.reason, /no recognised datastore|no build recipe/);
});

test("a repo with neither Dockerfile nor compose is not-flattenable", async () => {
  const plan = await classify(reader({ "package.json": "{}" }), "owner/app");
  assert.equal(plan.strategy, "not-flattenable");
  if (plan.strategy !== "not-flattenable") return;
  assert.match(plan.reason, /neither a Dockerfile nor a flattenable compose/);
});

test("a compose seed and start hint flow into the plan", async () => {
  const plan = await classify(reader({ "compose.yml": DVWA_COMPOSE }), "Vaibhav91one/DVWA", {
    composeSeedHint: { kind: "http", method: "GET", path: "/setup.php" },
  });
  if (plan.strategy !== "compose-synth") throw new Error("expected compose-synth");
  assert.deepEqual(plan.seed, { kind: "http", method: "GET", path: "/setup.php" });
});
