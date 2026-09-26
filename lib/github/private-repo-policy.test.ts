import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The private-repository policy end to end against real Postgres: the lifecycle webhooks record
 * visibility and the Contents permission, and every place that would clone or reproduce reads them.
 * GitHub itself is never called; the token mint is injected where a token would be minted.
 */

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let lifecycle: typeof import("./lifecycle");
let access: typeof import("./repo-access");
let authorize: typeof import("@/lib/targets/authorize-reproduction");
let identity: typeof import("@/lib/build-onboarding/source-identity");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("private_repo_policy");
  dbm = await import("@/lib/db");
  lifecycle = await import("./lifecycle");
  access = await import("./repo-access");
  authorize = await import("@/lib/targets/authorize-reproduction");
  identity = await import("@/lib/build-onboarding/source-identity");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

const INSTALLATION = { id: 910001, account: { login: "acme", id: 5001, type: "Organization" } };
const PRIVATE = { id: 810001, full_name: "acme/secret", private: true };
const PUBLIC = { id: 810002, full_name: "acme/open", private: false };
const LATE_PRIVATE = { id: 810003, full_name: "acme/later", private: true };

async function repo(repoId: number) {
  const [row] = await dbm.db
    .select({ isPrivate: dbm.connectedRepository.isPrivate, targetProfileId: dbm.connectedRepository.targetProfileId })
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.repoId, repoId));
  return row;
}

async function contentsPermission() {
  const [row] = await dbm.db
    .select({ contents: dbm.githubInstallation.contentsPermission })
    .from(dbm.githubInstallation)
    .where(dbm.eq(dbm.githubInstallation.installationId, INSTALLATION.id));
  return row?.contents;
}

async function queuedRepoIds(): Promise<number[]> {
  const rows = await dbm.db.select({ repoId: dbm.targetOnboarding.repoId }).from(dbm.targetOnboarding);
  return rows.map((r) => r.repoId).sort();
}

const noMint = (async () => {
  throw new Error("a token must not be minted for a refused repository");
}) as typeof import("./app-auth").mintInstallationToken;

let privateProfileId: string;

test("an install without Contents: read stores visibility, queues only the public repository", async () => {
  await lifecycle.applyLifecycle(dbm.db, "installation", {
    action: "created",
    installation: { ...INSTALLATION, permissions: { metadata: "read", issues: "write" } },
    repositories: [PRIVATE, PUBLIC],
  });

  assert.equal(await contentsPermission(), "none");
  assert.equal((await repo(PRIVATE.id)).isPrivate, true);
  assert.equal((await repo(PUBLIC.id)).isPrivate, false);
  assert.deepEqual(await queuedRepoIds(), [PUBLIC.id], "the private repository is not queued for a clone");
});

test("a later-added private repository is not queued either", async () => {
  await lifecycle.applyLifecycle(dbm.db, "installation_repositories", {
    action: "added",
    installation: { ...INSTALLATION, permissions: { metadata: "read", issues: "write" } },
    repositories_added: [LATE_PRIVATE],
  });
  assert.equal((await repo(LATE_PRIVATE.id)).isPrivate, true);
  assert.deepEqual(await queuedRepoIds(), [PUBLIC.id]);
});

test("without Contents: read nothing mints a token and nothing reads the private repository", async () => {
  await assert.rejects(access.repoReadToken(PRIVATE.full_name, { mint: noMint }), access.PolicyRefusedError);
  // The public repository is read anonymously.
  assert.equal(await access.repoReadToken(PUBLIC.full_name, { mint: noMint }), null);

  // Onboarding's first read of the repository refuses before any request leaves the process.
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("no request may be made");
  }) as typeof fetch;
  try {
    await assert.rejects(
      identity.resolveRepositoryCommit(PRIVATE.full_name, `https://github.com/${PRIVATE.full_name}.git`),
      /POLICY_REFUSED/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetched, false);
});

test("reproduction of a target bound to the private repository is POLICY_REFUSED", async () => {
  const [profile] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: "acme-secret", imageDigest: `sha256:${"a".repeat(64)}` })
    .returning({ id: dbm.targetProfile.id });
  privateProfileId = profile.id;
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ targetProfileId: profile.id })
    .where(dbm.eq(dbm.connectedRepository.repoId, PRIVATE.id));

  assert.deepEqual(
    await authorize.authorizeReproductionTarget({ targetProfileId: profile.id, recipeId: "any" }),
    { ok: false, reason: "POLICY_REFUSED" },
  );
});

test("accepting Contents: read queues the waiting private repositories and lets reproduction through", async () => {
  await lifecycle.applyLifecycle(dbm.db, "installation", {
    action: "new_permissions_accepted",
    installation: { ...INSTALLATION, permissions: { metadata: "read", issues: "write", contents: "read" } },
  });

  assert.equal(await contentsPermission(), "read");
  // The bound private repository keeps its target and is not rebuilt; the unbound one is queued.
  assert.deepEqual(await queuedRepoIds(), [PUBLIC.id, LATE_PRIVATE.id].sort());

  const result = await authorize.authorizeReproductionTarget({ targetProfileId: privateProfileId, recipeId: "any" });
  assert.equal(result.ok, false);
  assert.notEqual((result as { reason: string }).reason, "POLICY_REFUSED", "the policy no longer refuses");

  const calls: unknown[] = [];
  const mint = (async (installationId: number, repoId: number, opts?: { permissions?: unknown }) => {
    calls.push({ installationId, repoId, permissions: opts?.permissions });
    return { token: "ghs_accepted", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  }) as typeof import("./app-auth").mintInstallationToken;
  assert.equal(await access.repoReadToken(PRIVATE.full_name, { mint }), "ghs_accepted");
  assert.deepEqual(calls, [{ installationId: INSTALLATION.id, repoId: PRIVATE.id, permissions: { contents: "read" } }]);
});

test("a repository event without permissions leaves the stored permission alone", async () => {
  await lifecycle.applyLifecycle(dbm.db, "repository", {
    action: "renamed",
    installation: { id: INSTALLATION.id },
    repository: { id: PUBLIC.id, full_name: "acme/open-renamed" },
  });
  assert.equal(await contentsPermission(), "read");
});

test("privatized and publicized move visibility and nothing else", async () => {
  await lifecycle.applyLifecycle(dbm.db, "repository", {
    action: "privatized",
    installation: { id: INSTALLATION.id },
    repository: { id: PUBLIC.id, full_name: "acme/open-renamed", private: true },
  });
  assert.equal((await repo(PUBLIC.id)).isPrivate, true);

  await lifecycle.applyLifecycle(dbm.db, "repository", {
    action: "publicized",
    installation: { id: INSTALLATION.id },
    repository: { id: PRIVATE.id, full_name: PRIVATE.full_name, private: false },
  });
  const publicized = await repo(PRIVATE.id);
  assert.equal(publicized.isPrivate, false);
  assert.equal(publicized.targetProfileId, privateProfileId, "a visibility change is not a revocation");
});

test("the shared grant check refuses a private repository without Contents: read", async () => {
  const { hasActiveRepositoryGrant } = await import("@/lib/targets/repository-grant");
  const live = {
    targetProfileId: "p",
    connectedRepositoryId: "r",
    repoActive: true,
    repoArchivedAt: null,
    repoTargetProfileId: "p",
    installationSuspendedAt: null,
    installationDeletedAt: null,
  };
  assert.equal(hasActiveRepositoryGrant({ ...live, repoIsPrivate: false, installationContentsPermission: null }), true);
  assert.equal(hasActiveRepositoryGrant({ ...live, repoIsPrivate: true, installationContentsPermission: "none" }), false);
  assert.equal(hasActiveRepositoryGrant({ ...live, repoIsPrivate: true, installationContentsPermission: "read" }), true);
});
