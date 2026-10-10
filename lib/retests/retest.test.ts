import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

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
    .values({ installationId: 9000 + seq, accountLogin: "example", accountId: 1 })
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

async function refused(seeded: Awaited<ReturnType<typeof seedOriginal>>, sha: string, pattern: RegExp) {
  const before = await reportCount();
  const result = await retests.startRetest(seeded.original.id, sha, REVIEWER);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, pattern);
  assert.equal(await reportCount(), before, "a refusal creates no report");
}

test("a bad SHA is refused", async () => {
  const seeded = await seedOriginal();
  await refused(seeded, "main", /40-character/);
  await refused(seeded, "a".repeat(39), /40-character/);
});

test("a report that is not an approved REPRODUCED verdict is refused", async () => {
  await refused(await seedOriginal({ outcome: "NOT_REPRODUCED" }), SHA, /REPRODUCED/);
  await refused(await seedOriginal({ state: "AWAITING_APPROVAL" }), SHA, /REPRODUCED/);
});

test("a private or unknown-visibility repository is refused", async () => {
  await refused(await seedOriginal({ isPrivate: true }), SHA, /public/);
  await refused(await seedOriginal({ isPrivate: null }), SHA, /public/);
});

test("a revoked repository grant is refused", async () => {
  await refused(await seedOriginal({ repoActive: false }), SHA, /grant/);
});

test("a target not bound through a connected GitHub repository is refused", async () => {
  await refused(await seedOriginal({ connected: false }), SHA, /connected GitHub repository/);
});

test("a retest creates a git-material child with no contact and leaves the original untouched", async () => {
  const seeded = await seedOriginal();
  const before = await snapshot(seeded);

  const result = await retests.startRetest(seeded.original.id, SHA.toUpperCase(), REVIEWER);
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
  const target = upload.reviewedTarget as { definition: { config: { baseUrl: string } } };
  assert.equal(target.definition.config.baseUrl, "http://localhost:3000");

  const [link] = await dbm.db.select().from(dbm.retest).where(dbm.eq(dbm.retest.childReportId, child.id));
  assert.equal(link.originalReportId, seeded.original.id);
  assert.equal(link.originalVerdictId, seeded.verdict.id);
  assert.equal(link.commitSha, SHA);

  const again = await retests.startRetest(seeded.original.id, SHA, REVIEWER);
  assert.equal(again.ok, false, "the same commit is not retested twice for one verdict");
  await assert.rejects(
    dbm.db.insert(dbm.retest).values({
      originalReportId: seeded.original.id,
      originalVerdictId: seeded.verdict.id,
      childReportId: seeded.original.id,
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
  const started = await retests.startRetest(seeded.original.id, "c".repeat(40), REVIEWER);
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
  const started = await retests.startRetest(seeded.original.id, "d".repeat(40), REVIEWER);
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
});
