import assert from "node:assert/strict";
import test, { after, before } from "node:test";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let quarantine: typeof import("./quarantine");

const STALE_DIGEST = "sha256:123acb31ed8bb05ebb06934a29be83d4e11a46cae937b9ed2bf2bda29d98130a";
const STALE_SNAPSHOT = "<immutable-daytona-snapshot-id>";

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("quarantine");
  dbm = await import("@/lib/db");
  quarantine = await import("./quarantine");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let ids = 0;

/** A profile seeded the way it would have been before fail-closed validation existed. */
async function staleProfile(name: string) {
  const [row] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name, imageDigest: STALE_DIGEST, snapshotId: STALE_SNAPSHOT })
    .returning();
  return row;
}

async function connectedRepo(targetProfileId: string | null) {
  ids += 1;
  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId: 900_000 + ids, accountLogin: "acme", accountId: 77 })
    .returning({ id: dbm.githubInstallation.id });

  const [repo] = await dbm.db
    .insert(dbm.connectedRepository)
    .values({
      installationId: installation.id,
      repoId: 900_000 + ids,
      fullName: `acme/repo-${ids}`,
      targetProfileId,
    })
    .returning();
  return repo;
}

async function triagingReport(targetProfileId: string | null, connectedRepositoryId: string) {
  ids += 1;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:900000:issue:${ids}`,
      title: "test report",
      body: "body",
      connectedRepositoryId,
      targetProfileId,
    })
    .returning();
  return row;
}

test("quarantines a stale profile, keeps the report, clears the bindings", async () => {
  const profile = await staleProfile("quarantine-target-1");
  const repo = await connectedRepo(profile.id);
  const r = await triagingReport(profile.id, repo.id);

  const result = await quarantine.quarantineStaleTargetProfile({
    profileName: "quarantine-target-1",
    expectedImageDigest: STALE_DIGEST,
    expectedSnapshotId: STALE_SNAPSHOT,
    reason: "predates fail-closed validation",
  });

  assert.equal(result.quarantinedProfileId, profile.id);
  assert.deepEqual(result.clearedReportIds, [r.id]);
  assert.deepEqual(result.clearedRepositoryIds, [repo.id]);

  const [profileRow] = await dbm.db
    .select()
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.id, profile.id));
  assert.equal(profileRow, undefined, "the stale profile row is gone");

  const [reportRow] = await dbm.db.select().from(dbm.report).where(dbm.eq(dbm.report.id, r.id));
  assert.equal(reportRow.state, "ANALYSIS_ONLY", "the report survives, moved out of TRIAGING");
  assert.equal(reportRow.targetProfileId, null);

  const [repoRow] = await dbm.db
    .select()
    .from(dbm.connectedRepository)
    .where(dbm.eq(dbm.connectedRepository.id, repo.id));
  assert.equal(repoRow.targetProfileId, null);

  const events = await dbm.db
    .select({ type: dbm.sessionEvent.type, data: dbm.sessionEvent.data })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, r.id));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "target.invalidated");
  assert.equal((events[0].data as { targetProfileId: string }).targetProfileId, profile.id);
});

test("a digest or snapshot id that does not match the expected stale values is refused", async () => {
  const profile = await staleProfile("quarantine-target-2");

  await assert.rejects(
    quarantine.quarantineStaleTargetProfile({
      profileName: "quarantine-target-2",
      expectedImageDigest: `sha256:${"9".repeat(64)}`,
      expectedSnapshotId: STALE_SNAPSHOT,
      reason: "test",
    }),
    /does not match the expected stale values/,
  );

  const [row] = await dbm.db
    .select()
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.id, profile.id));
  assert.ok(row, "a profile that did not match was not touched");
});

test("a report already past TRIAGING blocks the whole quarantine", async () => {
  const profile = await staleProfile("quarantine-target-3");
  const repoA = await connectedRepo(profile.id);
  const repoB = await connectedRepo(profile.id);
  const staying = await triagingReport(profile.id, repoA.id);
  const moved = await triagingReport(profile.id, repoB.id);
  await dbm.db
    .update(dbm.report)
    .set({ state: "ANALYSIS_ONLY" })
    .where(dbm.eq(dbm.report.id, moved.id));

  await assert.rejects(
    quarantine.quarantineStaleTargetProfile({
      profileName: "quarantine-target-3",
      expectedImageDigest: STALE_DIGEST,
      expectedSnapshotId: STALE_SNAPSHOT,
      reason: "test",
    }),
    /not TRIAGING/,
  );

  const [profileRow] = await dbm.db
    .select()
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.id, profile.id));
  assert.ok(profileRow, "nothing is quarantined while any bound report fails the check");

  const [stayingRow] = await dbm.db
    .select({ state: dbm.report.state, targetProfileId: dbm.report.targetProfileId })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, staying.id));
  assert.equal(stayingRow.state, "TRIAGING", "the other report was not partially quarantined");
  assert.equal(stayingRow.targetProfileId, profile.id);
});

test("a report with an existing verdict blocks the whole quarantine", async () => {
  const profile = await staleProfile("quarantine-target-4");
  const repo = await connectedRepo(profile.id);
  const r = await triagingReport(profile.id, repo.id);
  await dbm.db.insert(dbm.verdict).values({
    reportId: r.id,
    outcome: "REPRODUCED",
    summary: "test",
    payload: "test",
    contentHash: "hash",
  });

  await assert.rejects(
    quarantine.quarantineStaleTargetProfile({
      profileName: "quarantine-target-4",
      expectedImageDigest: STALE_DIGEST,
      expectedSnapshotId: STALE_SNAPSHOT,
      reason: "test",
    }),
    /already has a verdict/,
  );

  const [profileRow] = await dbm.db
    .select()
    .from(dbm.targetProfile)
    .where(dbm.eq(dbm.targetProfile.id, profile.id));
  assert.ok(profileRow);
});
