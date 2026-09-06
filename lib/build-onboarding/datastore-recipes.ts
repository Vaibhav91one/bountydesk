import { type DatastoreEngine } from "./build-plan";

/**
 * A datastore recipe is the shell a datastore needs to live inside the app image: how to install it,
 * how to bring it up and create the app's database at build time so the data bakes into a layer, how
 * to shut it down cleanly, and how to start it at boot before the app. It is data, not pipeline code,
 * so a new engine is a new entry here rather than a change to the compiler.
 *
 * These recipes target a Debian/Ubuntu base, because the app images that need a bundled datastore are
 * overwhelmingly `*-apache`/`*-fpm` Debian images (DVWA is `php:8-apache`). An Alpine app base would
 * need an apk variant; the compiler refuses an engine whose recipe does not fit the detected base
 * rather than emit apt commands into an Alpine image.
 */

export type DatastoreCreds = { dbName: string; user: string; password: string };

export type DatastoreRecipe = {
  engine: DatastoreEngine;
  /** The data directory that must survive into the image layer after the build-time seed. */
  dataDir: string;
  /** Dockerfile-RUN shell that installs the server package(s). */
  install(): string;
  /** Build-time shell: start the daemon detached, wait until it answers, then create the database and
   *  user with the compose-declared credentials. Idempotent (safe to re-run). */
  bringUpAndInit(creds: DatastoreCreds): string;
  /** Build-time shell: flush and stop the daemon so the data directory is consistent in the layer. */
  shutdown(): string;
  /** Boot-time shell (goes in the entrypoint before the app): start the daemon detached, then block
   *  until it is ready, so the app starts against a live datastore. */
  bootAndWait(): string;
};

/** Single-quote a value for POSIX sh, so a compose-declared password with shell metacharacters cannot
 *  break out of the command. Not a security boundary (it is the target's own seed), but it keeps a
 *  literal password from corrupting the generated build. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const mariadb: DatastoreRecipe = {
  engine: "mariadb",
  dataDir: "/var/lib/mysql",
  install() {
    return [
      "apt-get update",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends mariadb-server",
      "rm -rf /var/lib/apt/lists/*",
      // The daemon needs its runtime socket directory; the package makes /var/lib/mysql but not always
      // /run/mysqld under a fresh build.
      "mkdir -p /run/mysqld && chown -R mysql:mysql /run/mysqld /var/lib/mysql",
    ].join(" && ");
  },
  bringUpAndInit(creds) {
    const { dbName, user, password } = creds;
    // Initialize the system tables if the data dir is empty, start mysqld as the mysql user in the
    // background, wait for the socket, then create the app database and user. Bound to loopback only.
    // Backticks are literal inside the single-quoted `mysql -e` argument, so the identifier is quoted
    // with plain backticks, not backslash-escaped ones.
    const sql = [
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`,
      `CREATE USER IF NOT EXISTS '${user}'@'localhost' IDENTIFIED BY ${shq(password)};`,
      `CREATE USER IF NOT EXISTS '${user}'@'127.0.0.1' IDENTIFIED BY ${shq(password)};`,
      `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${user}'@'localhost';`,
      `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${user}'@'127.0.0.1';`,
      "FLUSH PRIVILEGES;",
    ].join(" ");
    // The daemon start is wrapped in a subshell so its `&` backgrounding does not collide with the `&&`
    // that chains the wait and seed steps (`cmd & && next` is a shell syntax error).
    return [
      "( test -d /var/lib/mysql/mysql || mariadb-install-db --user=mysql --datadir=/var/lib/mysql >/dev/null )",
      "( mysqld_safe --datadir=/var/lib/mysql --skip-networking=0 --bind-address=127.0.0.1 & )",
      "for i in $(seq 1 60); do mysqladmin --protocol=socket ping >/dev/null 2>&1 && break; sleep 1; done",
      `mysql -e ${shq(sql)}`,
    ].join(" && ");
  },
  shutdown() {
    return "mysqladmin --protocol=socket shutdown && for i in $(seq 1 30); do mysqladmin --protocol=socket ping >/dev/null 2>&1 || break; sleep 1; done";
  },
  bootAndWait() {
    return [
      "mkdir -p /run/mysqld && chown -R mysql:mysql /run/mysqld",
      "( mysqld_safe --datadir=/var/lib/mysql --bind-address=127.0.0.1 & )",
      "for i in $(seq 1 60); do mysqladmin --protocol=socket ping >/dev/null 2>&1 && break; sleep 1; done",
    ].join(" && ");
  },
};

const RECIPES: Partial<Record<DatastoreEngine, DatastoreRecipe>> = {
  mariadb,
  // mysql shares MariaDB's client tooling and command surface closely enough that the MariaDB recipe
  // installs and seeds a MySQL-compatible server on Debian; a dedicated mysql recipe can replace this
  // if a target needs Oracle MySQL specifically.
  mysql: { ...mariadb, engine: "mysql" },
  // postgres and redis recipes are the next entries; until they exist the compiler refuses those
  // engines as not-flattenable rather than emitting commands that would not work.
};

export function getDatastoreRecipe(engine: DatastoreEngine): DatastoreRecipe | undefined {
  return RECIPES[engine];
}

export function hasDatastoreRecipe(engine: DatastoreEngine): boolean {
  return RECIPES[engine] !== undefined;
}
