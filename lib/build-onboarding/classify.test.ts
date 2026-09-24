import assert from "node:assert/strict";
import test from "node:test";

import {
  classify,
  composeArgv,
  detectEcosystem,
  dockerfileExposePort,
  ecosystemFromDockerfile,
  parseComposeMesh,
  parseComposeTopology,
  profileNameFromRepo,
  type SourceReader,
} from "./classify";
import { knownTargetHints } from "./known-target-hints";

test("known hints name the app for an owned mesh target with two published ports", async () => {
  const VULN_BANK = `
services:
  web:
    build: .
    ports: ["5000:5000", "80:5000"]
    depends_on: [db]
  db:
    image: postgres:13
`;
  const plan = await classify(
    reader({ "docker-compose.yml": VULN_BANK }),
    "Vaibhav91one/vuln-bank",
    knownTargetHints("Vaibhav91one/vuln-bank"),
  );
  assert.equal(plan.strategy, "compose-mesh");
  if (plan.strategy !== "compose-mesh") return;
  assert.equal(plan.appService, "web");
});

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

const PG_COMPOSE = `
services:
  web:
    build: .
    ports: ["8000:8000"]
    environment:
      DATABASE_HOST: db
    depends_on: [db]
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: secret
`;

test("parseComposeMesh enumerates services, picks the app, and infers the datastore port", () => {
  const mesh = parseComposeMesh(PG_COMPOSE);
  assert.equal(mesh.ok, true);
  if (!mesh.ok) return;
  assert.equal(mesh.appService, "web");
  assert.equal(mesh.appPort, 8000);
  const web = mesh.services.find((s) => s.service === "web")!;
  assert.equal(web.role, "app");
  assert.deepEqual(web.build, { context: "." });
  // Peer comes from both depends_on and the DATABASE_HOST env naming the db service.
  assert.deepEqual(web.peers, ["db"]);
  const db = mesh.services.find((s) => s.service === "db")!;
  assert.equal(db.role, "dependency");
  assert.equal(db.image, "postgres:16");
  assert.equal(db.port, 5432);
});

test("classify rejects absolute nested Compose build paths", async () => {
  await assert.rejects(
    () =>
      classify(
        reader({
          "deploy/docker/compose.yml": PG_COMPOSE.replace("build: .", "build: /tmp"),
        }),
        "owner/app",
      ),
    /repository-relative/,
  );
});

test("classify resolves nested Compose build paths relative to the manifest", async () => {
  const plan = await classify(
    reader({
      "deploy/docker/compose.yml": PG_COMPOSE,
      "deploy/docker/Dockerfile": "FROM node:20\nEXPOSE 8000",
      "package.json": "{}",
    }),
    "owner/app",
  );
  assert.equal(plan.strategy, "compose-mesh");
  if (plan.strategy !== "compose-mesh") return;
  assert.equal(plan.services.find((s) => s.role === "app")?.build?.context, "deploy/docker");
});

test("classify discovers Compose files in the standard deployment directory", async () => {
  const plan = await classify(
    reader({ "deploy/docker/docker-compose.yml": PG_COMPOSE, "package.json": "{}" }),
    "owner/app",
  );
  assert.equal(plan.strategy, "compose-mesh");
  assert.equal(plan.composePath, "deploy/docker/docker-compose.yml");
});

test("classify discovers nested compose.yml as well as docker-compose.yml", async () => {
  const plan = await classify(
    reader({ "deploy/docker/compose.yml": PG_COMPOSE, "package.json": "{}" }),
    "owner/app",
  );
  assert.equal(plan.strategy, "compose-mesh");
  assert.equal(plan.composePath, "deploy/docker/compose.yml");
});

test("classify preserves bare image references with Compose interpolation", () => {
  const topology = parseComposeMesh(`
services:
  app:
    image: "example/app:\${VERSION:-latest}"
    ports: ["8000:8000"]
  db:
    image: postgres:15
`);
  assert.equal(topology.ok, true);
  if (!topology.ok) return;
  assert.equal(topology.services.find((s) => s.service === "app")?.image, "example/app:latest");
});

test("a service relying on an environment the sandbox cannot provide is refused, not silently dropped", () => {
  const base = (extra: string) => `
services:
  web:
    build: .
    ports: ["5000:5000"]
${extra}
  db:
    image: postgres:13
`;

  const privileged = parseComposeMesh(base("    privileged: true"));
  assert.equal(privileged.ok, false);
  if (!privileged.ok) assert.match(privileged.reason, /runs privileged/);

  const hostNetwork = parseComposeMesh(base("    network_mode: host"));
  assert.equal(hostNetwork.ok, false);
  if (!hostNetwork.ok) assert.match(hostNetwork.reason, /host networking/);

  const caps = parseComposeMesh(base('    cap_add: ["NET_ADMIN"]'));
  assert.equal(caps.ok, false);
  if (!caps.ok) assert.match(caps.reason, /kernel capabilities/);

  const devices = parseComposeMesh(base('    devices: ["/dev/kvm"]'));
  assert.equal(devices.ok, false);
  if (!devices.ok) assert.match(devices.reason, /host devices/);

  const pidHost = parseComposeMesh(base("    pid: host"));
  assert.equal(pidHost.ok, false);
  if (!pidHost.ok) assert.match(pidHost.reason, /host PID namespace/);
});

test("a peer declared through a defaulted env value is resolved, not left literal", () => {
  const topology = parseComposeMesh(`
services:
  web:
    build: .
    ports: ["5000:5000"]
    environment:
      DB_HOST: "\${DB_HOST:-db}"
  db:
    image: postgres:13
`);
  assert.equal(topology.ok, true);
  if (!topology.ok) return;
  const web = topology.services.find((service) => service.service === "web")!;
  assert.equal(web.env?.DB_HOST, "db", "the placeholder must resolve to the peer name");
  assert.deepEqual(web.peers, ["db"], "the resolved value must register the peer edge");
});

test("classify routes a single-app-plus-postgres compose to a compose-mesh plan", async () => {
  const plan = await classify(reader({ "docker-compose.yml": PG_COMPOSE, "package.json": "{}" }), "owner/app");
  assert.equal(plan.strategy, "compose-mesh");
  if (plan.strategy !== "compose-mesh") return;
  assert.equal(plan.appService, "web");
  assert.equal(plan.services.length, 2);
  assert.equal(plan.runtime?.baseUrl, "http://localhost:8000");
});

test("classify refuses a compose with two published front doors instead of guessing the app", () => {
  const TWO_PUBLISHED = `
services:
  web:
    build: ./web
    ports: ["8080:8080"]
  api:
    build: ./api
    ports: ["9090:9090"]
  db:
    image: mariadb:10
`;
  const mesh = parseComposeMesh(TWO_PUBLISHED);
  assert.equal(mesh.ok, false);
  if (mesh.ok) return;
  assert.match(mesh.reason, /more than one service publishes an HTTP port \(web, api\)/);
});

test("classify accepts a mesh when the front door is named explicitly", async () => {
  const TWO_PUBLISHED = `
services:
  web:
    build: ./web
    ports: ["8080:8080"]
  api:
    build: ./api
    ports: ["9090:9090"]
  db:
    image: mariadb:10
`;
  const plan = await classify(reader({ "compose.yml": TWO_PUBLISHED }), "owner/app", {
    meshAppServiceHint: "api",
  });
  assert.equal(plan.strategy, "compose-mesh");
  if (plan.strategy !== "compose-mesh") return;
  assert.equal(plan.appService, "api");
  assert.equal(plan.services.filter((s) => s.role === "app").length, 1);
  assert.equal(plan.services.filter((s) => s.role === "dependency").length, 2);
});

test("a published front door wins over an internal expose when only one is published", () => {
  const ONE_PUBLISHED = `
services:
  web:
    build: ./web
    ports: ["8080:8080"]
  metrics:
    build: ./metrics
    expose: ["9090"]
  db:
    image: postgres:16
`;
  const mesh = parseComposeMesh(ONE_PUBLISHED);
  assert.equal(mesh.ok, true);
  if (!mesh.ok) return;
  assert.equal(mesh.appService, "web");
  assert.equal(mesh.appPort, 8080);
});

test("classify reports the mesh's own reason for an ambiguous front door", async () => {
  const TWO_PUBLISHED = `
services:
  web:
    build: ./web
    ports: ["8080:8080"]
  api:
    build: ./api
    ports: ["9090:9090"]
  db:
    image: mariadb:10
`;
  const plan = await classify(reader({ "compose.yml": TWO_PUBLISHED }), "owner/app");
  assert.equal(plan.strategy, "not-flattenable");
  if (plan.strategy !== "not-flattenable") return;
  assert.match(plan.reason, /more than one service publishes an HTTP port/);
});

test("parseComposeMesh drops a docker-socket sidecar and meshes the real services", () => {
  const mesh = parseComposeMesh(`
services:
  web:
    build: .
    ports: ["5000:5000"]
    environment:
      DB_HOST: db
  db:
    image: postgres:13
  autoheal:
    image: willfarrell/autoheal:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`);
  assert.equal(mesh.ok, true);
  if (!mesh.ok) return;
  assert.deepEqual(mesh.services.map((s) => s.service).sort(), ["db", "web"]);
  assert.equal(mesh.appService, "web");
});

test("a volume that merely contains the socket text as a substring is not treated as a sidecar", () => {
  const mesh = parseComposeMesh(`
services:
  web:
    build: .
    ports: ["5000:5000"]
    volumes:
      - ./cfg:/app/var/run/docker.sock.d
  db:
    image: postgres:13
`);
  assert.equal(mesh.ok, true);
  if (!mesh.ok) return;
  // web keeps its place: its volume target only contains the socket path as a substring.
  assert.deepEqual(mesh.services.map((s) => s.service).sort(), ["db", "web"]);
});

test("a compose that is only an app plus a docker-socket sidecar is not a mesh", () => {
  const mesh = parseComposeMesh(`
services:
  web:
    build: .
    ports: ["5000:5000"]
  autoheal:
    image: willfarrell/autoheal:latest
    volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"]
`);
  assert.equal(mesh.ok, false);
});

test("a single-service compose is not a mesh and keeps the flatten reason", () => {
  const mesh = parseComposeMesh(`
services:
  app:
    build: .
    ports: ["80:80"]
`);
  assert.equal(mesh.ok, false);
});

test("DVWA still flattens to compose-synth, not a mesh", async () => {
  // A single app plus a recipe-backed datastore is the flatten case; the mesh must not grab it.
  const plan = await classify(reader({ "docker-compose.yml": DVWA_COMPOSE }), "owner/dvwa");
  assert.equal(plan.strategy, "compose-synth");
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

test("an env-overrides hint merges over and wins against the compose-derived overrides", async () => {
  // The app service names the datastore by its compose service in DB_SERVER, so the datastore pass
  // rewrites it to loopback on its own.
  const composeWithAppEnv = `
services:
  dvwa:
    build: .
    ports: ["127.0.0.1:80:80"]
    environment:
      DB_SERVER: db
    depends_on: [db]
  db:
    image: mariadb:10
    environment:
      MYSQL_DATABASE: dvwa
      MYSQL_USER: dvwa
      MYSQL_PASSWORD: p@ss
`;
  const plan = await classify(reader({ "compose.yml": composeWithAppEnv }), "Vaibhav91one/DVWA", {
    envOverridesHint: { DEFAULT_SECURITY_LEVEL: "low" },
  });
  if (plan.strategy !== "compose-synth") throw new Error("expected compose-synth");
  // The datastore pass rewrote DB_SERVER=db to loopback, and the hint added the security level the
  // compose does not carry; both are present.
  assert.equal(plan.envOverrides?.DB_SERVER, "127.0.0.1");
  assert.equal(plan.envOverrides?.DEFAULT_SECURITY_LEVEL, "low");
});

// NodeGoat's compose, verbatim: the web command waits for mongo, seeds, then starts the app, and
// neither depends_on nor an env value equal to "mongo" names the peer.
const NODEGOAT_COMPOSE = `
version: "3.7"

services:
  web:
    build: .
    environment:
      NODE_ENV:
      MONGODB_URI: mongodb://mongo:27017/nodegoat
    command: sh -c "until nc -z -w 2 mongo 27017 && echo 'mongo is ready for connections' && node artifacts/db-reset.js && npm start; do sleep 2; done"
    ports:
      - "4000:4000"

  mongo:
    image: mongo:4.4
    user: mongodb
    expose:
      - 27017
`;

test("a compose command is carried into the mesh plan and its hosts become peers (NodeGoat)", async () => {
  const plan = await classify(
    reader({ "docker-compose.yml": NODEGOAT_COMPOSE, Dockerfile: "FROM node:12-alpine\n", "package.json": "{}" }),
    "Vaibhav91one/NodeGoat",
  );
  assert.equal(plan.strategy, "compose-mesh");
  if (plan.strategy !== "compose-mesh") return;
  const web = plan.services.find((service) => service.service === "web")!;
  const mongo = plan.services.find((service) => service.service === "mongo")!;
  assert.deepEqual(web.command, [
    "sh",
    "-c",
    "until nc -z -w 2 mongo 27017 && echo 'mongo is ready for connections' && node artifacts/db-reset.js && npm start; do sleep 2; done",
  ]);
  assert.equal(web.entrypoint, undefined, "no entrypoint override keeps the image's own");
  // The app reaches mongo through a URI and the wait loop, so mongo must get an /etc/hosts entry.
  assert.deepEqual(web.peers, ["mongo"]);
  assert.deepEqual(web.env, { MONGODB_URI: "mongodb://mongo:27017/nodegoat" });
  assert.equal(mongo.command, undefined);
  assert.equal(mongo.port, 27017);
  // The stored plan round-trips through the validator the worker reads it back with.
  const { parseBuildPlan } = await import("./build-plan");
  assert.deepEqual(parseBuildPlan(JSON.parse(JSON.stringify(plan))), plan);
});

test("compose command string form splits into words the way Compose does, without a shell", () => {
  assert.deepEqual(composeArgv("bundle exec thin -p 3000"), { argv: ["bundle", "exec", "thin", "-p", "3000"] });
  assert.deepEqual(composeArgv(`sh -c 'echo "a b"'`), { argv: ["sh", "-c", 'echo "a b"'] });
  assert.deepEqual(composeArgv(`sh -c "echo \\"hi\\" \\$$x"`), { argv: ["sh", "-c", 'echo "hi" $x'] });
  assert.deepEqual(composeArgv(`a\\ b "" c`), { argv: ["a b", "", "c"] });
  // $$ is Compose's literal $, and a defaulted variable is interpolated before splitting.
  assert.deepEqual(composeArgv(`sh -c 'echo $$HOSTNAME'`), { argv: ["sh", "-c", "echo $HOSTNAME"] });
  assert.deepEqual(composeArgv("serve --port ${PORT:-8080}"), { argv: ["serve", "--port", "8080"] });
  // A $$ inside a default is part of that default, not a place to cut the expression.
  assert.deepEqual(composeArgv("${FOO:-a$$b}"), { argv: ["a$b"] });
  assert.deepEqual(composeArgv(["${FOO-x$$}y", "$${literal}"]), { argv: ["x$y", "${literal}"] });
  // An empty string is an explicit empty override; null and absent keep the image default.
  assert.deepEqual(composeArgv(""), { argv: [] });
  assert.deepEqual(composeArgv(null), {});
  assert.deepEqual(composeArgv(undefined), {});
});

test("compose command list form is exec-form and keeps each item whole", () => {
  assert.deepEqual(composeArgv(["sh", "-c", "a && b"]), { argv: ["sh", "-c", "a && b"] });
  assert.deepEqual(composeArgv(["node", "server.js", 3000]), { argv: ["node", "server.js", "3000"] });
  assert.deepEqual(composeArgv([]), { argv: [] });
  assert.deepEqual(composeArgv(["echo", "$$HOME"]), { argv: ["echo", "$HOME"] });
});

test("a compose command that cannot be carried faithfully is refused with a reason", () => {
  for (const value of [
    "npm run migrate && npm start", // go-shellwords stops at &&, so Compose would run half of it
    "node server.js > /tmp/log",
    `sh -c "unclosed`,
    "echo $HOME", // a bare variable Compose would read from the host environment
    "echo ${REQUIRED:?set it}",
    "echo ${OUTER:-${INNER:-x}}", // nested interpolation is not modelled
    "echo ${UNTERMINATED:-x",
    "echo ${FOO:-a$b}", // a bare variable inside a default
    ["sh", "-c", "line one\nline two"],
    ["ok", { nested: true }],
    { not: "a command" },
  ]) {
    assert.ok("reason" in composeArgv(value), `expected a refusal for ${JSON.stringify(value)}`);
  }
  const mesh = parseComposeMesh(`
services:
  web:
    build: .
    ports: ["3000:3000"]
    command: npm run migrate && npm start
  db:
    image: postgres:13
`);
  assert.equal(mesh.ok, false);
  if (!mesh.ok) assert.match(mesh.reason, /service web command is not a plain word list/);
});

test("a compose entrypoint override is carried, and peers are named hosts, not substrings", () => {
  const mesh = parseComposeMesh(`
services:
  web:
    build: .
    ports: ["8000:8000"]
    entrypoint: ["/wait-for", "db:5432", "--"]
    command: ["gunicorn", "app:app"]
    environment:
      CACHE_URL: redis://cache.example.com:6379
      MONGO_DRIVER: mongodb
  db:
    image: postgres:13
  cache:
    image: redis:7
  mongo:
    image: mongo:4.4
`);
  assert.equal(mesh.ok, true);
  if (!mesh.ok) return;
  const web = mesh.services.find((service) => service.service === "web")!;
  assert.deepEqual(web.entrypoint, ["/wait-for", "db:5432", "--"]);
  assert.deepEqual(web.command, ["gunicorn", "app:app"]);
  // db is named in the entrypoint; "cache.example.com" and "mongodb" do not name cache or mongo.
  assert.deepEqual(web.peers, ["db"]);
});
