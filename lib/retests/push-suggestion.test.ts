import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * readPushSuggestion against a real Postgres: the grant check, the unique retest
 * index, the REPRODUCED-only gate, and the pinned-vs-pushed comparison are all
 * database-level guarantees. Disposable schema, db imported after createSchema.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let pushSuggestion: typeof import("./push-suggestion");

const REVIEWER = { login: "gatekeeper" };

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("push-suggestion");
  dbm = await import("@/lib/db");
  pushSuggestion = await import("./push-suggestion");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

/** A DELIVERED REPRODUCED report on a public connected repository with a built target. */
async function seedOriginal() {
  seq += 1;
  const { db } = dbm;
  const [profile] = await db
    .insert(dbm.targetProfile)
    .values({
      name: `target-${seq}`,
      imageName: "ghcr.io/example/app",
      imageDigest: `sha256:${"b".repeat(64)}`,
      snapshotId: "snap",
      config: {
        baseUrl: "http://localhost:3000",
        provisioning: { readinessPath: "/health", expectedBuildMarker: "m", startCommand: "npm start" },
      },
    })
    .returning();
  const [installation] = await db
    .insert(dbm.githubInstallation)
    .values({ installationId: 9000 + seq, accountLogin: "example", accountId: 1 })
    .returning();
  const [repo] = await db
    .insert(dbm.connectedRepository)
    .values({
      installationId: installation.id,
      repoId: 5000 + seq,
      fullName: `example/app-${seq}`,
      targetProfileId: profile.id,
      active: true,
      isPrivate: false,
    })
    .returning();
  const [original] = await db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:${repo.repoId}:issue:${seq}`,
      title: "SQL injection in search",
      body: "GET /search?q=' breaks out",
      state: "DELIVERED",
      connectedRepositoryId: repo.id,
      targetProfileId: profile.id,
    })
    .returning();
  const [v] = await db
    .insert(dbm.verdict)
    .values({
      reportId: original.id,
      outcome: "REPRODUCED",
      summary: "reproduced",
      payload: "payload",
      contentHash: "hash",
    })
    .returning();
  return { original, verdict: v, profile, repo, installation };
}

test("readPushSuggestion returns the pushed commit and branch when ahead of the pinned SHA", async () => {
  const seeded = await seedOriginal();
  const pinnedSha = "a".repeat(40);
  const pushedSha = "b".repeat(40);
  await dbm.db
    .update(dbm.targetProfile)
    .set({ resolvedCommitSha: pinnedSha })
    .where(dbm.eq(dbm.targetProfile.id, seeded.profile.id));
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ latestPushedCommitSha: pushedSha, latestPushedBranch: "main" })
    .where(dbm.eq(dbm.connectedRepository.id, seeded.repo.id));

  const suggestion = await pushSuggestion.readPushSuggestion(seeded.original.id);
  assert.ok(suggestion, "a push ahead of the pinned commit surfaces a suggestion");
  assert.equal(suggestion?.commitSha, pushedSha);
  assert.equal(suggestion?.shortSha, pushedSha.slice(0, 12));
  assert.equal(suggestion?.branch, "main");
});

test("readPushSuggestion is null when the pushed commit matches the pinned SHA", async () => {
  const seeded = await seedOriginal();
  const sha = "c".repeat(40);
  await dbm.db
    .update(dbm.targetProfile)
    .set({ resolvedCommitSha: sha })
    .where(dbm.eq(dbm.targetProfile.id, seeded.profile.id));
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ latestPushedCommitSha: sha, latestPushedBranch: "main" })
    .where(dbm.eq(dbm.connectedRepository.id, seeded.repo.id));

  const suggestion = await pushSuggestion.readPushSuggestion(seeded.original.id);
  assert.equal(suggestion, null, "the pushed commit matches the pinned commit");
});

test("readPushSuggestion is null when no push has been recorded", async () => {
  const seeded = await seedOriginal();
  await dbm.db
    .update(dbm.targetProfile)
    .set({ resolvedCommitSha: "a".repeat(40) })
    .where(dbm.eq(dbm.targetProfile.id, seeded.profile.id));

  const suggestion = await pushSuggestion.readPushSuggestion(seeded.original.id);
  assert.equal(suggestion, null, "no push event has written a latest_pushed_commit_sha");
});

test("readPushSuggestion is null when a retest already exists for the pushed commit", async () => {
  const seeded = await seedOriginal();
  const pinnedSha = "a".repeat(40);
  const pushedSha = "b".repeat(40);
  await dbm.db
    .update(dbm.targetProfile)
    .set({ resolvedCommitSha: pinnedSha })
    .where(dbm.eq(dbm.targetProfile.id, seeded.profile.id));
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ latestPushedCommitSha: pushedSha, latestPushedBranch: "main" })
    .where(dbm.eq(dbm.connectedRepository.id, seeded.repo.id));

  // Start a retest at that commit so the suggestion should vanish.
  const { startRetest } = await import("./retest");
  await startRetest(seeded.original.id, { kind: "git", commitSha: pushedSha }, REVIEWER);

  const suggestion = await pushSuggestion.readPushSuggestion(seeded.original.id);
  assert.equal(suggestion, null, "a retest at the pushed commit hides the suggestion");
});

test("readPushSuggestion is null when the grant is revoked", async () => {
  const seeded = await seedOriginal();
  const pushedSha = "b".repeat(40);
  await dbm.db
    .update(dbm.targetProfile)
    .set({ resolvedCommitSha: "a".repeat(40) })
    .where(dbm.eq(dbm.targetProfile.id, seeded.profile.id));
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ latestPushedCommitSha: pushedSha, latestPushedBranch: "main" })
    .where(dbm.eq(dbm.connectedRepository.id, seeded.repo.id));

  // Suspend the installation, which hasActiveRepositoryGrant checks against.
  await dbm.db
    .update(dbm.githubInstallation)
    .set({ suspendedAt: new Date() })
    .where(dbm.eq(dbm.githubInstallation.id, seeded.installation.id));

  const suggestion = await pushSuggestion.readPushSuggestion(seeded.original.id);
  assert.equal(suggestion, null, "a suspended installation shows no suggestion");
});

test("readPushSuggestion is null for a private repository", async () => {
  const seeded = await seedOriginal();
  const pushedSha = "b".repeat(40);
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ latestPushedCommitSha: pushedSha, latestPushedBranch: "main", isPrivate: true })
    .where(dbm.eq(dbm.connectedRepository.id, seeded.repo.id));

  const suggestion = await pushSuggestion.readPushSuggestion(seeded.original.id);
  assert.equal(suggestion, null, "private repositories are excluded from the suggestion");
});
