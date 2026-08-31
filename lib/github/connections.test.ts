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

async function installation(
  opts: { suspended?: boolean; deleted?: boolean; accountType?: string | null } = {},
) {
  ids += 1;
  const [row] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({
      installationId: 700_000 + ids,
      accountLogin: `acct-${String(ids).padStart(3, "0")}`,
      accountId: 900 + ids,
      accountType: opts.accountType ?? "User",
      suspendedAt: opts.suspended ? new Date() : null,
      deletedAt: opts.deleted ? new Date() : null,
    })
    .returning({ id: dbm.githubInstallation.id });

  return row;
}

async function repo(
  installationRowId: string,
  opts: { active?: boolean; archived?: boolean; configured?: boolean } = {},
): Promise<string> {
  ids += 1;
  const [row] = await dbm.db
    .insert(dbm.connectedRepository)
    .values({
      installationId: installationRowId,
      repoId: 800_000 + ids,
      fullName: `acme/repo-${String(ids).padStart(3, "0")}`,
      active: opts.active ?? true,
      archivedAt: opts.archived ? new Date() : null,
      targetProfileId: opts.configured === false ? null : targetProfileId,
    })
    .returning({ id: dbm.connectedRepository.id });

  return row.id;
}

async function report(
  connectedRepositoryId: string | null,
  opts: { state?: string; hidden?: boolean } = {},
) {
  ids += 1;
  await dbm.db.insert(dbm.report).values({
    channel: "github",
    sourceRef: `github:1:issue:${ids}`,
    title: `report ${ids}`,
    body: "body",
    state: (opts.state ?? "TRIAGING") as "TRIAGING",
    connectedRepositoryId,
    hiddenAt: opts.hidden ? new Date() : null,
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

test("manage repositories points at the right GitHub settings page", () => {
  // A personal installation lives under /settings.
  assert.equal(
    connections.manageRepositoriesUrl(156822754, { login: "octocat", type: "User" }),
    "https://github.com/settings/installations/156822754",
  );

  // An organization keeps its installation settings somewhere else entirely, and sending an
  // org operator to the personal path is a 404.
  assert.equal(
    connections.manageRepositoriesUrl(156822754, { login: "acme-inc", type: "Organization" }),
    "https://github.com/organizations/acme-inc/settings/installations/156822754",
  );

  // Rows written before the account type was recorded do not guess a type-specific path.
  assert.equal(
    connections.manageRepositoriesUrl(156822754, { login: "octocat", type: null }),
    null,
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

test("the granted count follows the grant, not the display status", async () => {
  const live = await installation();
  await repo(live.id);                        // granted
  await repo(live.id, { configured: false }); // granted, just unconfigured
  await repo(live.id, { active: false });     // withdrawn

  const all = await connections.listConnections();
  const row = all.find((c) => c.installationRowId === live.id);

  assert.equal(row?.repositories.length, 3, "all three are still listed");
  assert.equal(row?.grantedRepositoryCount, 2, "only the two the installation still grants");
});

test("a suspended installation still reports its real grant count", async () => {
  // Every repository here displays as "suspended", which would hide whether the grant is
  // intact if the count were derived from the status.
  const suspended = await installation({ suspended: true });
  await repo(suspended.id);
  await repo(suspended.id, { active: false });

  const all = await connections.listConnections();
  const row = all.find((c) => c.installationRowId === suspended.id);

  assert.deepEqual(row?.repositories.map((r) => r.status), ["suspended", "suspended"]);
  assert.equal(row?.grantedRepositoryCount, 1);
});

test("last synced follows repository changes, not just the installation row", async () => {
  const live = await installation();
  await repo(live.id);

  const before = (await connections.listConnections())
    .find((c) => c.installationRowId === live.id)!.lastSyncedAt;

  // A rename or transfer touches only connected_repository. Reading the installation alone
  // would report a stale time and call it synchronisation.
  const later = new Date(Date.now() + 60_000);
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ updatedAt: later })
    .where(dbm.eq(dbm.connectedRepository.installationId, live.id));

  const after = (await connections.listConnections())
    .find((c) => c.installationRowId === live.id)!.lastSyncedAt;

  assert.ok(after > before, "the repository write moved it forward");
  assert.equal(after.getTime(), later.getTime());
});

test("a repository counts the reports it has actually sent", async () => {
  const install = await installation();
  const sender = await repo(install.id);
  const quiet = await repo(install.id);

  await report(sender);
  await report(sender, { state: "AWAITING_APPROVAL" });
  await report(sender, { state: "DELIVERED" });
  await report(sender, { state: "DELIVERED" });
  // Hidden rows are off every list in the product, so they are off this count too.
  await report(sender, { state: "DELIVERED", hidden: true });
  // Another repository's reports, and one that arrived through no repository at all.
  await report(quiet);
  await report(null);

  const rows =
    (await connections.listConnections()).find((c) => c.installationRowId === install.id)
      ?.repositories ?? [];

  const counted = rows.find((r) => r.connectedRepositoryId === sender);
  assert.deepEqual(
    { ...counted?.reports, lastReportAt: counted?.reports.lastReportAt !== null },
    { total: 4, awaitingReview: 1, delivered: 2, lastReportAt: true },
  );

  assert.equal(rows.find((r) => r.connectedRepositoryId === quiet)?.reports.total, 1);
});

test("a repository that has sent nothing reports zeros rather than nothing", async () => {
  // The panel draws these straight, so an absent entry would render "undefined reports".
  const install = await installation();
  const silent = await repo(install.id);

  const rows =
    (await connections.listConnections()).find((c) => c.installationRowId === install.id)
      ?.repositories ?? [];

  assert.deepEqual(rows.find((r) => r.connectedRepositoryId === silent)?.reports, {
    total: 0,
    awaitingReview: 0,
    delivered: 0,
    lastReportAt: null,
  });
});
