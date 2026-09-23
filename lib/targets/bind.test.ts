import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Binding is the only way an email report can ever reach a definitive verdict, so the gate it has
 * to satisfy is the thing under test: `assertVerdictInsertAllowed` refuses REPRODUCED without a
 * bound target and an active repository grant, and nothing here may weaken that. These run
 * against real Postgres because every guard is a row lock or a join.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let bind: typeof import("./bind");
let grant: typeof import("./repository-grant");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("target_bind");

  dbm = await import("@/lib/db");
  bind = await import("./bind");
  grant = await import("./repository-grant");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function seedProfile(opts: { repo?: "active" | "archived" | "suspended" | "none" } = {}) {
  seq += 1;
  const n = seq;
  const [profile] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: `target-${n}`, imageDigest: `sha256:fixture-${n}` })
    .returning({ id: dbm.targetProfile.id, name: dbm.targetProfile.name });

  const kind = opts.repo ?? "none";
  if (kind === "none") return { profile, repoId: null as string | null };

  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({
      installationId: 700000 + n,
      accountLogin: `acct-${n}`,
      accountId: 600000 + n,
      accountType: "User",
      suspendedAt: kind === "suspended" ? new Date() : null,
    })
    .returning({ id: dbm.githubInstallation.id });

  const [repo] = await dbm.db
    .insert(dbm.connectedRepository)
    .values({
      installationId: installation.id,
      repoId: 500000 + n,
      fullName: `acme/repo-${n}`,
      targetProfileId: profile.id,
      archivedAt: kind === "archived" ? new Date() : null,
    })
    .returning({ id: dbm.connectedRepository.id });

  return { profile, repoId: repo.id };
}

async function seedEmailReport(state: string = "ANALYSIS_ONLY") {
  seq += 1;
  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "email",
      sourceRef: `email:<bind-${seq}@mail.example>`,
      title: `report ${seq}`,
      body: "body",
      state: state as never,
      reporterContact: "reporter@example.test",
      connectedRepositoryId: null,
      targetProfileId: null,
    })
    .returning({ id: dbm.report.id });
  return r.id;
}

async function readReport(id: string) {
  const [row] = await dbm.db
    .select({
      targetProfileId: dbm.report.targetProfileId,
      connectedRepositoryId: dbm.report.connectedRepositoryId,
    })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, id));
  return row;
}

test("binding an unowned target leaves no repository, which reads as always active", () => {
  // The pinned demo target has no connected repository. hasActiveRepositoryGrant treats a null
  // repository as always active, which is right for a target nobody can revoke.
  return (async () => {
    const { profile } = await seedProfile();
    const reportId = await seedEmailReport();

    const result = await bind.bindTarget(reportId, profile.id, "reviewer");
    assert.deepEqual(result, { ok: true, targetName: profile.name });

    const row = await readReport(reportId);
    assert.equal(row.targetProfileId, profile.id);
    assert.equal(row.connectedRepositoryId, null);

    const snapshot = await grant.loadRepositoryGrantSnapshot(reportId, dbm.db);
    assert.ok(snapshot);
    assert.equal(grant.hasActiveRepositoryGrant(snapshot), true);
  })();
});

test("binding a repo-owned target copies the repository, so a later revoke still stops it", async () => {
  const { profile, repoId } = await seedProfile({ repo: "active" });
  const reportId = await seedEmailReport();

  assert.equal((await bind.bindTarget(reportId, profile.id, "reviewer")).ok, true);
  assert.equal((await readReport(reportId)).connectedRepositoryId, repoId);

  const before = await grant.loadRepositoryGrantSnapshot(reportId, dbm.db);
  assert.equal(grant.hasActiveRepositoryGrant(before!), true);

  // The whole reason the repository is copied: revoking it has to reach the email report too.
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ active: false })
    .where(dbm.eq(dbm.connectedRepository.id, repoId!));

  const after = await grant.loadRepositoryGrantSnapshot(reportId, dbm.db);
  assert.equal(grant.hasActiveRepositoryGrant(after!), false);
});

test("a target whose repository is already revoked is refused rather than bound uselessly", async () => {
  for (const kind of ["archived", "suspended"] as const) {
    const { profile } = await seedProfile({ repo: kind });
    const reportId = await seedEmailReport();

    const result = await bind.bindTarget(reportId, profile.id, "reviewer");
    assert.equal(result.ok, false, `${kind} should refuse`);
    assert.match((result as { reason: string }).reason, /no longer grants access/);
    // Nothing written, so the report is still bindable to something else.
    assert.equal((await readReport(reportId)).targetProfileId, null);
  }
});

test("a terminal report cannot change what it was judged against", async () => {
  for (const state of ["DELIVERED", "DENIED", "CANCELLED"]) {
    const { profile } = await seedProfile();
    const reportId = await seedEmailReport(state);
    const result = await bind.bindTarget(reportId, profile.id, "reviewer");
    assert.equal(result.ok, false, `${state} should refuse`);
    assert.equal((await readReport(reportId)).targetProfileId, null);
  }
});

test("a delivering report is refused: its verdict is already on the way out", async () => {
  const { profile } = await seedProfile();
  const reportId = await seedEmailReport("DELIVERING");
  const result = await bind.bindTarget(reportId, profile.id, "reviewer");
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /delivering/);
});

test("a report that already has a target is not silently rebound", async () => {
  const first = await seedProfile();
  const second = await seedProfile();
  const reportId = await seedEmailReport();

  assert.equal((await bind.bindTarget(reportId, first.profile.id, "reviewer")).ok, true);

  const result = await bind.bindTarget(reportId, second.profile.id, "reviewer");
  assert.equal(result.ok, false);
  assert.equal((await readReport(reportId)).targetProfileId, first.profile.id);
});

test("an unknown profile id binds nothing", async () => {
  const reportId = await seedEmailReport();
  const result = await bind.bindTarget(
    reportId,
    "00000000-0000-0000-0000-000000000000",
    "reviewer",
  );
  assert.equal(result.ok, false);
  assert.equal((await readReport(reportId)).targetProfileId, null);
});

test("binding records an audit event naming the target and who chose it", async () => {
  const { profile } = await seedProfile();
  const reportId = await seedEmailReport();
  await bind.bindTarget(reportId, profile.id, "vaibhav");

  const events = await dbm.db
    .select({ type: dbm.sessionEvent.type, data: dbm.sessionEvent.data })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, reportId));

  const bound = events.find((e) => e.type === "target.bound");
  assert.ok(bound, "binding is the one place a human picks what gets executed against");
  assert.equal((bound.data as { targetName: string }).targetName, profile.name);
  assert.equal((bound.data as { reviewer: string }).reviewer, "vaibhav");
});

test("the picker lists built profiles with the digest that identifies the image", async () => {
  const { profile } = await seedProfile();
  const listed = await bind.listTargetProfiles();
  const found = listed.find((p) => p.id === profile.id);
  assert.ok(found);
  assert.equal(found.name, profile.name);
  assert.ok(found.imageDigest, "a profile with no digest is not something to reproduce against");
});

test("binding is what opens the verdict gate, and revoking closes it again", async () => {
  // The point of the whole feature. assertVerdictInsertAllowed is unchanged; this shows a report
  // going from "only ANALYSIS_ONLY is permitted here" to a definitive outcome being allowed,
  // purely because a human bound a target.
  const { profile, repoId } = await seedProfile({ repo: "active" });
  const reportId = await seedEmailReport();

  const before = await grant.loadRepositoryGrantSnapshot(reportId, dbm.db);
  assert.equal(before, null, "no bound target means there is no grant to check at all");

  assert.equal((await bind.bindTarget(reportId, profile.id, "reviewer")).ok, true);

  const after = await grant.loadRepositoryGrantSnapshot(reportId, dbm.db);
  assert.ok(after, "a bound report now has a grant to check");
  assert.equal(grant.hasActiveRepositoryGrant(after), true, "REPRODUCED is now permitted");

  await dbm.db
    .update(dbm.githubInstallation)
    .set({ suspendedAt: new Date() })
    .where(
      dbm.eq(
        dbm.githubInstallation.id,
        (
          await dbm.db
            .select({ id: dbm.connectedRepository.installationId })
            .from(dbm.connectedRepository)
            .where(dbm.eq(dbm.connectedRepository.id, repoId!))
        )[0].id,
      ),
    );

  const revoked = await grant.loadRepositoryGrantSnapshot(reportId, dbm.db);
  assert.equal(grant.hasActiveRepositoryGrant(revoked!), false, "a suspension closes it again");
});
