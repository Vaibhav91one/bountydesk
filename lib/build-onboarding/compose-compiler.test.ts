import assert from "node:assert/strict";
import test from "node:test";

import { getDatastoreRecipe } from "./datastore-recipes";
import { synthesizeComposeDockerfile } from "./compose-compiler";

const mariadb = getDatastoreRecipe("mariadb");
if (!mariadb) throw new Error("mariadb recipe missing");

// DVWA-shaped input: FROM the app image the driver built from DVWA's own Dockerfile, plus a MariaDB
// bundled in, its config host rewritten to loopback, and an http seed at /setup.php.
function dvwaDockerfile() {
  return synthesizeComposeDockerfile({
    appImageRef: "bountydesk-app-stage:latest",
    datastores: [{ recipe: mariadb!, creds: { dbName: "dvwa", user: "dvwa", password: "p@ss" } }],
    configRewrites: [{ file: "/var/www/html/config/config.inc.php", from: "db", to: "127.0.0.1" }],
    seed: { kind: "http", method: "GET", path: "/setup.php" },
    buildMarker: "abc123",
    appStartCommand: "apache2-foreground",
    appPort: 80,
  });
}

test("the synthesized DVWA Dockerfile is FROM the built app image", () => {
  assert.match(dvwaDockerfile(), /^FROM bountydesk-app-stage:latest/m);
});

test("it installs the datastore and, for an http seed, curl", () => {
  const df = dvwaDockerfile();
  assert.match(df, /apt-get install -y --no-install-recommends mariadb-server/);
  assert.match(df, /install -y --no-install-recommends curl/);
});

test("it rewrites the app config db host to loopback", () => {
  assert.match(dvwaDockerfile(), /sed -i 's\/db\/127\.0\.0\.1\/' '\/var\/www\/html\/config\/config\.inc\.php'/);
});

test("it seeds at build in one RUN: bring up, create db, hit setup, shut down", () => {
  const df = dvwaDockerfile();
  // create database with the compose creds; backticks are plain (literal inside the single-quoted SQL)
  assert.match(df, /CREATE DATABASE IF NOT EXISTS `dvwa`/);
  // the password is single-quoted inside the SQL, and the whole SQL is single-quoted for `mysql -e`,
  // so it reaches the layer double-escaped; assert it survives rather than a naive quoting.
  assert.match(df, /CREATE USER IF NOT EXISTS/);
  assert.ok(df.includes("p@ss"), "the password reaches the seed SQL");
  // the daemon is backgrounded in a subshell so it does not break the && chain
  assert.match(df, /\( mysqld_safe .* & \)/);
  // the app is started, /setup.php is hit, then stopped, and the datastore is shut down cleanly
  assert.match(df, /curl -fsS -X GET http:\/\/127\.0\.0\.1:80\/setup\.php/);
  assert.match(df, /mysqladmin --protocol=socket shutdown/);
  // all of that is a single RUN so the seeded data dir commits as one layer
  assert.ok(df.includes("RUN set -eu"), "seed is one RUN");
});

test("it writes the build marker and a boot entrypoint that starts the db then the app", () => {
  const df = dvwaDockerfile();
  assert.match(df, /echo 'abc123' > \/etc\/bountydesk-build-marker/);
  assert.match(df, /ENTRYPOINT \["\/usr\/local\/bin\/bountydesk-start"\]/);
  // the entrypoint script boots mariadb and waits before exec-ing the app
  assert.match(df, /mysqld_safe --datadir=\/var\/lib\/mysql/);
  assert.match(df, /exec apache2-foreground/);
});

test("a none seed still creates the empty database but hits no url", () => {
  const df = synthesizeComposeDockerfile({
    appImageRef: "app:1",
    datastores: [{ recipe: mariadb!, creds: { dbName: "app", user: "u", password: "pw" } }],
    seed: { kind: "none" },
    buildMarker: "m",
    appStartCommand: "node server.js",
    appPort: 3000,
  });
  assert.match(df, /CREATE DATABASE IF NOT EXISTS/);
  assert.doesNotMatch(df, /curl -fsS -X/);
  assert.doesNotMatch(df, /install -y --no-install-recommends curl/);
});

test("a command seed installs curl and emits the command verbatim in the seed RUN", () => {
  const df = synthesizeComposeDockerfile({
    appImageRef: "app:1",
    datastores: [{ recipe: mariadb!, creds: { dbName: "dvwa", user: "dvwa", password: "p@ss" } }],
    seed: { kind: "command", command: "apache2-foreground & curl -fsS http://127.0.0.1:80/setup.php" },
    buildMarker: "m",
    appStartCommand: "apache2-foreground",
    appPort: 80,
  });
  // a command seed can drive the app over HTTP too, so curl is installed for it, not only for http
  assert.match(df, /install -y --no-install-recommends curl/);
  assert.ok(df.includes("curl -fsS http://127.0.0.1:80/setup.php"), "the command runs verbatim");
});

test("synthesis refuses an empty datastore list", () => {
  assert.throws(
    () =>
      synthesizeComposeDockerfile({
        appImageRef: "app:1",
        datastores: [],
        seed: { kind: "none" },
        buildMarker: "m",
        appStartCommand: "x",
        appPort: 80,
      }),
    /needs at least one datastore/,
  );
});
