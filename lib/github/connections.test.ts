import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Imported dynamically, after createSchema has set DATABASE_SCHEMA: connections.ts pulls in
 * @/lib/db, which builds its pool at import time, so a static import would bind the pool to
 * the wrong schema before the harness got a say.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let connections: typeof import("./connections");
let targetProfileId: string;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("connections");

  dbm = await import("@/lib/db");
  connections = await import("./connections");

  const [profile] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: "juice-shop-v17.3.0", imageDigest: `sha256:${"0".repeat(64)}` })
    .returning({ id: dbm.targetProfile.id });

  targetProfileId = profile.id;
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let ids = 0;

async function installation(opts: { suspended?: boolean; deleted?: boolean } = {}) {
  ids += 1;
  const [row] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({
      installationId: 700_000 + ids,
      accountLogin: `acct-${String(ids).padStart(3, "0")}`,
      accountId: 900 + ids,
      suspendedAt: opts.suspended ? new Date() : null,
      deletedAt: opts.deleted ? new Date() : null,
    })
    .returning({ id: dbm.githubInstallation.id });

  return row;
}

async function repo(
  installationRowId: string,
  opts: { active?: boolean; archived?: boolean; configured?: boolean } = {},
) {
  ids += 1;
  await dbm.db.insert(dbm.connectedRepository).values({
    installationId: installationRowId,
    repoId: 800_000 + ids,
    fullName: `acme/repo-${String(ids).padStart(3, "0")}`,
    active: opts.active ?? true,
    archivedAt: opts.archived ? new Date() : null,
    targetProfileId: opts.configured === false ? null : targetProfileId,
  });
}

test("status reports the most severe reason first", () => {
  const base = {
    installationSuspended: false,
    active: true,
    archivedAt: null as Date | null,
    targetProfileId: "t" as string | null,
  };

  assert.equal(connections.repoStatus(base), "admissible");
  assert.equal(connections.repoStatus({ ...base, targetProfileId: null }), "not-configured");
  assert.equal(connections.repoStatus({ ...base, archivedAt: new Date() }), "archived");
  assert.equal(connections.repoStatus({ ...base, active: false }), "disconnected");
  assert.equal(connections.repoStatus({ ...base, installationSuspended: true }), "suspended");

  // A row can fail several at once. The operator needs the reason that says what to fix, and
  // a suspended installation makes every other reason moot.
  assert.equal(
    connections.repoStatus({
      installationSuspended: true,
      active: false,
      archivedAt: new Date(),
      targetProfileId: null,
    }),
    "suspended",
  );
  assert.equal(
    connections.repoStatus({
      installationSuspended: false,
      active: false,
      archivedAt: new Date(),
      targetProfileId: null,
    }),
    "disconnected",
  );
});

test("manage repositories points at GitHub, which owns repository selection", () => {
  assert.equal(
    connections.manageRepositoriesUrl(156822754),
    "https://github.com/settings/installations/156822754",
  );
});

test("every status is derived from the real rows", async () => {
  const live = await installation();
  await repo(live.id);
  await repo(live.id, { configured: false });
  await repo(live.id, { archived: true });
  await repo(live.id, { active: false });

  const suspended = await installation({ suspended: true });
  await repo(suspended.id);

  const all = await connections.listConnections();

  const liveRow = all.find((c) => c.installationRowId === live.id);
  assert.deepEqual(
    liveRow?.repositories.map((r) => r.status).sort(),
    ["admissible", "archived", "disconnected", "not-configured"],
  );
  assert.equal(
    liveRow?.repositories.find((r) => r.status === "admissible")?.targetProfileName,
    "juice-shop-v17.3.0",
  );
  assert.equal(
    liveRow?.repositories.find((r) => r.status === "not-configured")?.targetProfileName,
    null,
  );

  // Otherwise fine, but the installation is suspended, so nothing under it is admissible.
  const suspendedRow = all.find((c) => c.installationRowId === suspended.id);
  assert.deepEqual(suspendedRow?.repositories.map((r) => r.status), ["suspended"]);
  assert.ok(suspendedRow?.suspendedAt);
});

test("a tombstoned installation is not listed at all", async () => {
  const gone = await installation({ deleted: true });
  await repo(gone.id);

  const all = await connections.listConnections();

  assert.equal(all.some((c) => c.installationRowId === gone.id), false);
});

test("an installation that granted no repositories still appears", async () => {
  const empty = await installation();

  const all = await connections.listConnections();
  const row = all.find((c) => c.installationRowId === empty.id);

  // The left join hands back one null-filled row here; it must not become a phantom repo.
  assert.ok(row, "the installation is listed");
  assert.deepEqual(row?.repositories, []);
});
