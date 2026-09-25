import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

/**
 * Real Postgres, because the guarantee under test is the one-way-safe set of column moves the
 * webhooks make and reconcile has to match exactly. GitHub stays a fake fetch so the "GitHub says
 * this is gone" and "GitHub did not answer" cases are deterministic.
 *
 * signAppJwt reads these at call time, so they must exist before reconcile mints the App JWT it
 * uses to list installations. A throwaway keypair is enough; nothing here verifies the signature.
 */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
process.env.GITHUB_APP_ID = "123456";
process.env.GITHUB_APP_PRIVATE_KEY_BASE64 = Buffer.from(privateKey).toString("base64");

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let reconcile: typeof import("./reconcile");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("github_reconcile");
  dbm = await import("@/lib/db");
  reconcile = await import("./reconcile");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

// reconcile scans every non-deleted installation, so each test starts from an empty set. Neither
// table is append-only, so a plain delete is allowed here (unlike the evidence tables).
beforeEach(async () => {
  await dbm.db.delete(dbm.connectedRepository);
  await dbm.db.delete(dbm.githubInstallation);
});

let seq = 0;

async function seedInstallation(
  opts: { suspended?: boolean; deleted?: boolean } = {},
): Promise<{ rowId: string; installationId: number }> {
  seq += 1;
  const installationId = 700000 + seq;
  const [row] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({
      installationId,
      accountLogin: `acct-${seq}`,
      accountId: 600000 + seq,
      accountType: "User",
      suspendedAt: opts.suspended ? new Date() : null,
      deletedAt: opts.deleted ? new Date() : null,
    })
    .returning({ id: dbm.githubInstallation.id });
  return { rowId: row.id, installationId };
}

async function seedRepo(
  installationRowId: string,
  opts: { bound?: boolean; active?: boolean } = {},
): Promise<number> {
  seq += 1;
  const repoId = 500000 + seq;
  let targetProfileId: string | null = null;
  if (opts.bound !== false) {
    const [tp] = await dbm.db
      .insert(dbm.targetProfile)
      .values({ name: `target-${seq}`, imageDigest: `sha256:fixture-${seq}` })
      .returning({ id: dbm.targetProfile.id });
    targetProfileId = tp.id;
  }
  await dbm.db.insert(dbm.connectedRepository).values({
    installationId: installationRowId,
    repoId,
    fullName: `acme/repo-${seq}`,
    targetProfileId,
    active: opts.active ?? true,
  });
  return repoId;
}

async function installationRow(rowId: string) {
  const [row] = await dbm.db
    .select({
      suspendedAt: dbm.githubInstallation.suspendedAt,
      deletedAt: dbm.githubInstallation.deletedAt,
    })
    .from(dbm.githubInstallation)
    .where(dbm.eq(dbm.githubInstallation.id, rowId));
  return row;
}

async function repoRow(repoId: number) {
  const [row] = await dbm.db
    .select({
      active: dbm.connectedRepository.active,
      targetProfileId: dbm.connectedRepository.targetProfileId,
    })
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId));
  return row;
}

const fakeMint = async () => ({
  token: "ghs_reconcile_fake",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
});

function fakeFetch(handlers: {
  installations?: unknown;
  installationsStatus?: number;
  repos?: unknown;
  reposStatus?: number;
}): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/app/installations")) {
      if (handlers.installationsStatus && handlers.installationsStatus >= 400) {
        return new Response("boom", { status: handlers.installationsStatus });
      }
      return Response.json(handlers.installations ?? []);
    }
    if (u.includes("/installation/repositories")) {
      if (handlers.reposStatus && handlers.reposStatus >= 400) {
        return new Response("boom", { status: handlers.reposStatus });
      }
      return Response.json(handlers.repos ?? { repositories: [] });
    }
    throw new Error(`unexpected url ${u}`);
  }) as typeof fetch;
}

test("an installation GitHub no longer lists is tombstoned and its targets cleared", async () => {
  const inst = await seedInstallation();
  const repoId = await seedRepo(inst.rowId, { bound: true });

  const summary = await reconcile.reconcileGitHubAccess({
    fetchImpl: fakeFetch({ installations: [] }),
    mintToken: fakeMint,
  });

  assert.equal(summary.installationsRevoked, 1);
  const row = await installationRow(inst.rowId);
  assert.ok(row.deletedAt, "deleted_at must be set for an uninstalled installation");
  assert.equal(
    (await repoRow(repoId)).targetProfileId,
    null,
    "the target binding must be cleared so intake refuses the repository",
  );
});

test("an installation GitHub reports suspended is marked suspended and unconfigured", async () => {
  const inst = await seedInstallation();
  const repoId = await seedRepo(inst.rowId, { bound: true });

  const summary = await reconcile.reconcileGitHubAccess({
    fetchImpl: fakeFetch({
      installations: [{ id: inst.installationId, suspended_at: "2026-09-25T00:00:00Z" }],
    }),
    mintToken: fakeMint,
  });

  assert.equal(summary.installationsRevoked, 1);
  const row = await installationRow(inst.rowId);
  assert.ok(row.suspendedAt, "suspended_at must be set");
  assert.equal(row.deletedAt, null, "a suspension is not a deletion");
  assert.equal((await repoRow(repoId)).targetProfileId, null);
});

test("a repository removed from a live installation is revoked, the others left alone", async () => {
  const inst = await seedInstallation();
  const kept = await seedRepo(inst.rowId, { bound: true });
  const removed = await seedRepo(inst.rowId, { bound: true });

  const summary = await reconcile.reconcileGitHubAccess({
    fetchImpl: fakeFetch({
      installations: [{ id: inst.installationId, suspended_at: null }],
      repos: { repositories: [{ id: kept }] },
    }),
    mintToken: fakeMint,
  });

  assert.equal(summary.repositoriesRevoked, 1);
  const removedRow = await repoRow(removed);
  assert.equal(removedRow.active, false);
  assert.equal(removedRow.targetProfileId, null);

  const keptRow = await repoRow(kept);
  assert.equal(keptRow.active, true, "a still-granted repository must be untouched");
  assert.ok(keptRow.targetProfileId, "its target binding must survive");
});

test("reconcile never re-opens a tombstone, a suspension, or a cleared target", async () => {
  const dead = await seedInstallation({ deleted: true });
  const deadRepo = await seedRepo(dead.rowId, { bound: false, active: false });
  const suspended = await seedInstallation({ suspended: true });
  const suspendedRepo = await seedRepo(suspended.rowId, { bound: false });

  // GitHub reports both live and unsuspended, and lists their repositories. Reconcile must not use
  // any of that to restore access.
  const summary = await reconcile.reconcileGitHubAccess({
    fetchImpl: fakeFetch({
      installations: [
        { id: dead.installationId, suspended_at: null },
        { id: suspended.installationId, suspended_at: null },
      ],
      repos: { repositories: [{ id: deadRepo }, { id: suspendedRepo }] },
    }),
    mintToken: fakeMint,
  });

  // A tombstoned installation is not even scanned, and a DB-suspended one is skipped before any
  // repository read, so nothing is revoked and nothing is restored.
  assert.equal(summary.installationsRevoked, 0);
  assert.equal(summary.repositoriesRevoked, 0);

  const deadRow = await installationRow(dead.rowId);
  assert.ok(deadRow.deletedAt, "tombstone must stay");
  const suspendedRow = await installationRow(suspended.rowId);
  assert.ok(suspendedRow.suspendedAt, "suspension must stay");
  assert.equal(suspendedRow.deletedAt, null);
  assert.equal(
    (await repoRow(suspendedRepo)).targetProfileId,
    null,
    "a cleared target is never restored by reconcile",
  );
});

test("a failed installations read revokes nothing", async () => {
  const inst = await seedInstallation();
  const repoId = await seedRepo(inst.rowId, { bound: true });

  const summary = await reconcile.reconcileGitHubAccess({
    fetchImpl: fakeFetch({ installationsStatus: 503 }),
    mintToken: fakeMint,
  });

  assert.equal(summary.installationsRevoked, 0);
  assert.equal(summary.repositoriesRevoked, 0);
  assert.equal(summary.errors.length, 1);
  const row = await installationRow(inst.rowId);
  assert.equal(row.deletedAt, null, "a failed read must not tombstone a live installation");
  assert.ok((await repoRow(repoId)).targetProfileId, "its target must survive a failed read");
});

test("a failed repository read leaves that installation's repositories alone", async () => {
  const inst = await seedInstallation();
  const repoId = await seedRepo(inst.rowId, { bound: true });

  const summary = await reconcile.reconcileGitHubAccess({
    fetchImpl: fakeFetch({
      installations: [{ id: inst.installationId, suspended_at: null }],
      reposStatus: 500,
    }),
    mintToken: fakeMint,
  });

  assert.equal(summary.repositoriesRevoked, 0);
  assert.equal(summary.errors.length, 1);
  const row = await repoRow(repoId);
  assert.equal(row.active, true);
  assert.ok(row.targetProfileId, "a repository must not be revoked on a read that failed");
});
