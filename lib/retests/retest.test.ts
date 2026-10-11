import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import type { GitRetestMaterial, UploadRetestMaterial } from "./retest";

/**
 * Fix-verification against a real Postgres: the guarantees are the database's (the child's contact
 * is null, no outbound row is written, the original rows are not edited), so a mock would agree with
 * a wrong implementation. Disposable schema, db imported after createSchema.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let retests: typeof import("./retest");
let publish: typeof import("@/lib/mcp/publish-verdict");

const SHA = "a".repeat(40);
const REVIEWER = { login: "gatekeeper" };

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("retest");
  dbm = await import("@/lib/db");
  retests = await import("./retest");
  publish = await import("@/lib/mcp/publish-verdict");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

type Seed = {
  state?: "DELIVERED" | "DELIVERING" | "AWAITING_APPROVAL";
  outcome?: "REPRODUCED" | "NOT_REPRODUCED";
  isPrivate?: boolean | null;
  repoActive?: boolean;
  connected?: boolean;
  contentsPermission?: string | null;
};

/** A delivered REPRODUCED report on a public connected repository with a built target. */
async function seedOriginal(opts: Seed = {}) {
  seq += 1;
  const { db } = dbm;
  const [profile] = await db
    .insert(dbm.targetProfile)
    .values({
      name: `target-${seq}-${randomUUID()}`,
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
    .values({
      installationId: 9000 + seq,
      accountLogin: "example",
      accountId: 1,
      contentsPermission: opts.contentsPermission !== undefined ? opts.contentsPermission : "read",
    })
    .returning();
  const [repo] = await db
    .insert(dbm.connectedRepository)
    .values({
      installationId: installation.id,
      repoId: 5000 + seq,
      fullName: `example/app-${seq}`,
      targetProfileId: profile.id,
      active: opts.repoActive ?? true,
      isPrivate: opts.isPrivate === undefined ? false : opts.isPrivate,
    })
    .returning();
  const connected = opts.connected ?? true;
  const [original] = await db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:${repo.repoId}:issue:${seq}`,
      title: "SQL injection in search",
      body: "GET /search?q=' breaks out",
      state: opts.state ?? "DELIVERED",
      connectedRepositoryId: connected ? repo.id : null,
      targetProfileId: profile.id,
    })
    .returning();
  const [v] = await db
    .insert(dbm.verdict)
    .values({
      reportId: original.id,
      outcome: opts.outcome ?? "REPRODUCED",
      summary: "reproduced",
      payload: "payload",
      contentHash: "hash",
    })
    .returning();
  return { original, verdict: v, profile, repo };
}

/** A delivered REPRODUCED report with a connectionless target (no bound repository). */
async function seedConnectionless() {
  seq += 1;
  const { db } = dbm;
  const [profile] = await db
    .insert(dbm.targetProfile)
    .values({
      name: `connless-${seq}-${randomUUID()}`,
      imageName: "ghcr.io/example/app",
      imageDigest: `sha256:${"b".repeat(64)}`,
      snapshotId: "snap",
      config: {
        baseUrl: "http://localhost:3000",
        provisioning: { readinessPath: "/health" },
      },
    })
    .returning();
  const [original] = await db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:issue:${seq}`,
      title: "RCE in parser",
      body: "POST /parse accepts shell",
      state: "DELIVERED",
      connectedRepositoryId: null,
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
  return { original, verdict: v, profile };
}

async function snapshot(seeded: Awaited<ReturnType<typeof seedOriginal>>) {
  const { db, eq } = dbm;
  const [r] = await db.select().from(dbm.report).where(eq(dbm.report.id, seeded.original.id));
  const verdicts = await db.select().from(dbm.verdict).where(eq(dbm.verdict.reportId, seeded.original.id));
  const [p] = await db.select().from(dbm.targetProfile).where(eq(dbm.targetProfile.id, seeded.profile.id));
  const [c] = await db.select().from(dbm.connectedRepository).where(eq(dbm.connectedRepository.id, seeded.repo.id));
  return JSON.stringify({ r, verdicts, p, bound: c.targetProfileId });
}

async function reportCount() {
  const [row] = await dbm.db.select({ n: dbm.sql<number>`count(*)::int` }).from(dbm.report);
  return row?.n ?? 0;
}

async function refused(seeded: Awaited<ReturnType<typeof seedOriginal>>, material: GitRetestMaterial | UploadRetestMaterial, pattern: RegExp) {
  const before = await reportCount();
  const result = await retests.startRetest(seeded.original.id, material, REVIEWER);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, pattern);
  assert.equal(await reportCount(), before, "a refusal creates no report");
}

test("a bad SHA is refused", async () => {
  const seeded = await seedOriginal();
  await refused(seeded, { kind: "git", commitSha: "main" } as GitRetestMaterial, /40-character/);
  await refused(seeded, { kind: "git", commitSha: "a".repeat(39) } as GitRetestMaterial, /40-character/);
});

test("a report that is not an approved REPRODUCED verdict is refused", async () => {
  await refused(await seedOriginal({ outcome: "NOT_REPRODUCED" }), { kind: "git", commitSha: SHA }, /REPRODUCED/);
  await refused(await seedOriginal({ state: "AWAITING_APPROVAL" }), { kind: "git", commitSha: SHA }, /REPRODUCED/);
});

test("a private repository is refused without Contents read", async () => {
  await refused(await seedOriginal({ isPrivate: true, contentsPermission: null }), { kind: "git", commitSha: SHA }, /POLICY_REFUSED/);
});

test("a private repository with Contents read is accepted", async () => {
  const seeded = await seedOriginal({ isPrivate: true, contentsPermission: "read" });
  const result = await retests.startRetest(seeded.original.id, { kind: "git", commitSha: SHA }, REVIEWER);
  assert.ok(result.ok, `expected acceptance, got: ${JSON.stringify(result)}`);
  if (result.ok) {
    const [child] = await dbm.db
      .select()
      .from(dbm.report)
      .where(dbm.eq(dbm.report.id, result.childReportId));
    assert.equal(child.reporterContact, null);
    assert.equal(child.targetProfileId, null);
  }
});

test("a revoked repository grant is refused", async () => {
  await refused(await seedOriginal({ repoActive: false }), { kind: "git", commitSha: SHA }, /grant/);
});

test("a git commit retest requires a connected GitHub repository", async () => {
  await refused(await seedOriginal({ connected: false }), { kind: "git", commitSha: SHA }, /connected GitHub repository/);
});

test("a retest creates a git-material child with no contact and leaves the original untouched", async () => {
  const seeded = await seedOriginal();
  const before = await snapshot(seeded);

  const result = await retests.startRetest(seeded.original.id, { kind: "git", commitSha: SHA }, REVIEWER);
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(await snapshot(seeded), before, "original report, verdict, target and binding are unchanged");

  const [child] = await dbm.db.select().from(dbm.report).where(dbm.eq(dbm.report.id, result.childReportId));
  assert.equal(child.channel, "upload");
  assert.equal(child.state, "TRIAGING", "approved by the triggering reviewer, so it skips the gate");
  assert.equal(child.reporterContact, null);
  assert.equal(child.verifiedSender, null);
  assert.equal(child.targetProfileId, null);
  assert.match(child.body, new RegExp(`fix-verification retest at commit ${SHA}`));

  const [upload] = await dbm.db
    .select()
    .from(dbm.uploadIntake)
    .where(dbm.eq(dbm.uploadIntake.reportId, child.id));
  assert.equal(upload.materialKind, "git");
  assert.equal(upload.gitUrl, `https://github.com/${seeded.repo.fullName}`);
  assert.equal(upload.gitCommitSha, SHA);
  assert.equal(upload.buildState, "PENDING");
  assert.equal(upload.approvedBy, REVIEWER.login);
  assert.equal(upload.isRetest, true, "the child is flagged as a retest so the build loop fails it fast");
  const target = upload.reviewedTarget as { definition: { config: { baseUrl: string } } };
  assert.equal(target.definition.config.baseUrl, "http://localhost:3000");

  const [link] = await dbm.db.select().from(dbm.retest).where(dbm.eq(dbm.retest.childReportId, child.id));
  assert.equal(link.originalReportId, seeded.original.id);
  assert.equal(link.originalVerdictId, seeded.verdict.id);
  assert.equal(link.commitSha, SHA);
  assert.equal(link.materialKind, "git");

  const again = await retests.startRetest(seeded.original.id, { kind: "git", commitSha: SHA }, REVIEWER);
  assert.equal(again.ok, false, "the same commit is not retested twice for one verdict");
  await assert.rejects(
    dbm.db.insert(dbm.retest).values({
      originalReportId: seeded.original.id,
      originalVerdictId: seeded.verdict.id,
      childReportId: seeded.original.id,
      materialKind: "git",
      commitSha: SHA,
      actor: "racer",
    }),
    "the database, not a prior read, stops a concurrent duplicate",
  );
  assert.equal(await retests.canOfferRetest(seeded.original.id), true);
  await dbm.db.update(dbm.connectedRepository).set({ active: false }).where(dbm.eq(dbm.connectedRepository.id, seeded.repo.id));
  assert.equal(await retests.canOfferRetest(seeded.original.id), false, "a revoked grant hides the control");

  const of = await retests.readRetestOf(child.id);
  assert.equal(of?.originalReportId, seeded.original.id);
  assert.equal(await retests.readRetestOf(seeded.original.id), null);
});

test("a child retest report can never enqueue an outbound delivery", async () => {
  const seeded = await seedOriginal();
  const started = await retests.startRetest(seeded.original.id, { kind: "git", commitSha: "c".repeat(40) }, REVIEWER);
  assert.ok(started.ok);
  if (!started.ok) return;

  // Even with an approved REPRODUCED verdict in the right state, delivery has nowhere to go.
  await dbm.db.update(dbm.report).set({ state: "AWAITING_APPROVAL" }).where(dbm.eq(dbm.report.id, started.childReportId));
  const [childVerdict] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: started.childReportId,
      outcome: "REPRODUCED",
      summary: "still reproduces",
      payload: "payload",
      contentHash: "hash",
    })
    .returning();

  const outcome = await dbm.db.transaction((tx) =>
    publish.enqueueApprovedVerdictDelivery(tx, randomUUID(), childVerdict, "hash"),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /no verified reporter contact/);

  const deliveries = await dbm.db
    .select()
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.reportId, started.childReportId));
  assert.equal(deliveries.length, 0);
});

test("a connectionless upload retest creates a child with no contact and leaves the original untouched", async () => {
  const seeded = await seedConnectionless();
  const { singleFileTar } = await import("@/lib/upload/intake");
  const tar = singleFileTar("README.md", Buffer.from("fix for the bug"));

  const result = await retests.startRetest(seeded.original.id, {
    kind: "upload",
    archive: new File([new Uint8Array(tar)], "source.tar.gz"),
  }, REVIEWER);
  assert.ok(result.ok, `expected acceptance, got: ${JSON.stringify(result)}`);
  if (!result.ok) return;

  const [child] = await dbm.db.select().from(dbm.report).where(dbm.eq(dbm.report.id, result.childReportId));
  assert.equal(child.channel, "upload");
  assert.equal(child.reporterContact, null);
  assert.equal(child.targetProfileId, null);
  assert.match(child.body, /reviewer-supplied material/);

  const [upload] = await dbm.db
    .select()
    .from(dbm.uploadIntake)
    .where(dbm.eq(dbm.uploadIntake.reportId, child.id));
  assert.equal(upload.materialKind, "archive");
  assert.equal(upload.buildState, "PENDING");
  assert.equal(upload.approvedBy, REVIEWER.login);
  assert.equal(upload.isRetest, true, "upload retest children are flagged isRetest so the build loop fails them fast");

  const [link] = await dbm.db.select().from(dbm.retest).where(dbm.eq(dbm.retest.childReportId, child.id));
  assert.equal(link.materialKind, "upload");
  assert.equal(link.commitSha, null);
  assert.equal(link.originalReportId, seeded.original.id);
});

test("an upload retest with invalid material is refused", async () => {
  const seeded = await seedConnectionless();
  const before = await reportCount();

  // Not a tarball: parseUploadForm rejects it before any row is written.
  const result = await retests.startRetest(seeded.original.id, {
    kind: "upload",
    archive: new File([Buffer.from("not a tarball")], "source.txt"),
  }, REVIEWER);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /source archive must be a \.tar or \.tar\.gz file/);
  assert.equal(await reportCount(), before, "a refusal creates no report");
});

test("an upload retest with no material is refused", async () => {
  const seeded = await seedConnectionless();
  const before = await reportCount();

  const result = await retests.startRetest(seeded.original.id, { kind: "upload" }, REVIEWER);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no target material/);
  assert.equal(await reportCount(), before, "a refusal creates no report");
});

test("an upload retest on a report with a connected repository is refused", async () => {
  const seeded = await seedOriginal();
  const before = await reportCount();

  const result = await retests.startRetest(seeded.original.id, { kind: "upload" }, REVIEWER);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no connected repository/);
  assert.equal(await reportCount(), before, "a refusal creates no report");
});

test("a git retest on a connectionless report is refused", async () => {
  const seeded = await seedConnectionless();
  const before = await reportCount();

  const result = await retests.startRetest(seeded.original.id, { kind: "git", commitSha: SHA }, REVIEWER);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /connected GitHub repository/);
  assert.equal(await reportCount(), before, "a refusal creates no report");
});

test("the result is derived from the child's verdict: REPRODUCED is NOT_FIXED, NOT_REPRODUCED is FIXED", () => {
  const derive = retests.deriveRetestResult;
  const base = { buildState: "BUILT", childState: "AWAITING_APPROVAL" };
  assert.equal(derive({ ...base, outcome: "REPRODUCED" }), "NOT_FIXED");
  assert.equal(derive({ ...base, outcome: "NOT_REPRODUCED" }), "FIXED");
  assert.equal(derive({ ...base, outcome: "ANALYSIS_ONLY" }), "INCONCLUSIVE");
  assert.equal(derive({ ...base, outcome: "INCONCLUSIVE" }), "INCONCLUSIVE");
  assert.equal(derive({ outcome: null, buildState: "FAILED", childState: "TRIAGING" }), "INCONCLUSIVE");
  assert.equal(derive({ outcome: null, buildState: "BUILDING", childState: "TRIAGING" }), null);
  assert.equal(derive({ outcome: null, buildState: "BUILT", childState: "DENIED" }), "INCONCLUSIVE");
});

test("PARTIALLY_FIXED is never assigned automatically", () => {
  for (const outcome of ["REPRODUCED", "NOT_REPRODUCED", "ANALYSIS_ONLY", "INCONCLUSIVE", null] as const) {
    for (const buildState of ["PENDING", "BUILDING", "BUILT", "FAILED", null]) {
      assert.notEqual(retests.deriveRetestResult({ outcome, buildState, childState: "TRIAGING" }), "PARTIALLY_FIXED");
    }
  }
});

test("listRetests reads the latest child verdict", async () => {
  const seeded = await seedOriginal();
  const started = await retests.startRetest(seeded.original.id, { kind: "git", commitSha: "d".repeat(40) }, REVIEWER);
  assert.ok(started.ok);
  if (!started.ok) return;

  assert.equal((await retests.listRetests(seeded.original.id))[0].result, null, "still running");
  await dbm.db.insert(dbm.verdict).values({
    reportId: started.childReportId,
    outcome: "NOT_REPRODUCED",
    summary: "gone",
    payload: "p",
    contentHash: "h",
  });
  const [row] = await retests.listRetests(seeded.original.id);
  assert.equal(row.result, "FIXED");
  assert.equal(row.childReportId, started.childReportId);
  assert.equal(row.commitSha, "d".repeat(40), "listRetests carries the nullable commitSha through");
});

test("two concurrent identical upload retests create exactly one child", async () => {
  const seeded = await seedConnectionless();
  const { singleFileTar } = await import("@/lib/upload/intake");
  const tar = singleFileTar("README.md", Buffer.from("fix for the bug"));
  const material: UploadRetestMaterial = {
    kind: "upload",
    archive: new File([new Uint8Array(tar)], "source.tar.gz"),
  };

  // Fire both at once. The advisory lock serializes them, so one wins and the other is refused
  // as a duplicate rather than both creating a child report.
  const [first, second] = await Promise.all([
    retests.startRetest(seeded.original.id, material, REVIEWER),
    retests.startRetest(seeded.original.id, material, REVIEWER),
  ]);

  const okCount = [first, second].filter((r) => r.ok).length;
  const refused = [first, second].filter((r) => !r.ok).map((r) => (!r.ok ? r.reason : ""));
  assert.equal(okCount, 1, `exactly one child should be created; first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  assert.equal(refused.length, 1, "one was refused");
  assert.match(refused[0] ?? "", /already retested/);

  // Only one child report row exists for this verdict.
  const children = await dbm.db
    .select({ id: dbm.report.id })
    .from(dbm.report)
    .innerJoin(dbm.retest, dbm.eq(dbm.retest.childReportId, dbm.report.id))
    .where(dbm.eq(dbm.retest.originalVerdictId, seeded.verdict.id));
  assert.equal(children.length, 1, "only one child report was created");
});

test("an upload retest whose material matches a prior row beyond the old 100-row cap is still refused", async () => {
  const seeded = await seedConnectionless();
  const { singleFileTar } = await import("@/lib/upload/intake");
  const tar = singleFileTar("README.md", Buffer.from("fix for the bug"));
  const { createHash } = await import("node:crypto");

  // Insert a matching child retest row first (the one we are trying to reproduce), then 100
  // non-matching ones to push it past the old .limit(100) cap.
  const { db, eq } = dbm;
  for (let i = 0; i < 101; i++) {
    const [child] = await db
      .insert(dbm.report)
      .values({
        channel: "upload",
        sourceRef: `upload:dupe-${i}`,
        title: `dupe ${i}`,
        body: "body",
        state: "TRIAGING",
        targetProfileId: seeded.profile.id,
      })
      .returning();
    const archiveBytes = i === 0 ? Buffer.from(tar) : Buffer.from(`non-matching-${i}`);
    const md5Digest = `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`;
    await db.insert(dbm.uploadIntake).values({
      reportId: child.id,
      senderKey: "test",
      senderDomain: "test",
      materialKind: "archive",
      archive: i === 0 ? Buffer.from(tar) : null,
      sourceArchiveDigest: md5Digest,
      isRetest: true,
      buildState: "BUILT",
      approvedBy: "tester",
    });
    await db.insert(dbm.retest).values({
      originalReportId: seeded.original.id,
      originalVerdictId: seeded.verdict.id,
      childReportId: child.id,
      materialKind: "upload",
      commitSha: null,
      actor: "tester",
    });
  }

  // The matching row is buried under 100 non-matching ones. The dedupe must still find it.
  const result = await retests.startRetest(seeded.original.id, {
    kind: "upload",
    archive: new File([new Uint8Array(tar)], "source.tar.gz"),
  }, REVIEWER);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /already retested/);
  // No additional child was created.
  const children = await db
    .select({ id: dbm.report.id })
    .from(dbm.report)
    .innerJoin(dbm.retest, eq(dbm.retest.childReportId, dbm.report.id))
    .where(eq(dbm.retest.originalVerdictId, seeded.verdict.id));
  assert.equal(children.length, 101, "no extra child was created");
});
