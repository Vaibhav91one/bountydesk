import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

/**
 * Runs against a real Postgres for the same reason lib/jobs/queue.test.ts does: the
 * guarantee under test is the database's unique (report_id, revision) index, and a mock
 * would agree with a wrong implementation of the retry path.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

type DbModule = typeof import("@/lib/db");
type LifecycleModule = typeof import("./lifecycle");
type HashModule = typeof import("./hash");

let dbm: DbModule;
let lifecycle: LifecycleModule;
let hash: HashModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("verdicts");

  dbm = await import("@/lib/db");
  lifecycle = await import("./lifecycle");
  hash = await import("./hash");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

async function seedReport(): Promise<string> {
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `test:${randomUUID()}`,
      title: "t",
      body: "b",
      reporterHandle: null,
      connectedRepositoryId: null,
      targetProfileId: null,
    })
    .returning({ id: dbm.report.id });
  return row.id;
}

test("ensureInitialVerdict is a no-op retry when called twice with identical input", async () => {
  const reportId = await seedReport();
  const id = randomUUID();
  const payload = `hello\n<!-- bountydesk-delivery:${id} -->`;
  const input = {
    id,
    reportId,
    outcome: "ANALYSIS_ONLY" as const,
    summary: "s",
    payload,
  };

  const first = await lifecycle.ensureInitialVerdict(input);
  const second = await lifecycle.ensureInitialVerdict(input);

  assert.equal(second.id, first.id);
  assert.equal(second.payload, first.payload);
  assert.equal(second.contentHash, first.contentHash);

  const rows = await dbm.db
    .select({ id: dbm.verdict.id })
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(rows.length, 1, "a retry must not insert a second row");
});

test("ensureInitialVerdict computes the content hash from the payload", async () => {
  const reportId = await seedReport();
  const id = randomUUID();
  const payload = `server-owned hash\n<!-- bountydesk-delivery:${id} -->`;

  const created = await lifecycle.ensureInitialVerdict({
    id,
    reportId,
    outcome: "ANALYSIS_ONLY",
    summary: "s",
    payload,
  });

  assert.equal(created.contentHash, hash.computeContentHash(payload));
});

test("ensureInitialVerdict refuses a second write that disagrees with the one on record", async () => {
  const reportId = await seedReport();
  const id = randomUUID();
  const payload = `hello\n<!-- bountydesk-delivery:${id} -->`;
  const input = {
    id,
    reportId,
    outcome: "ANALYSIS_ONLY" as const,
    summary: "s",
    payload,
  };

  await lifecycle.ensureInitialVerdict(input);

  const conflictingId = randomUUID();
  const conflicting = {
    ...input,
    id: conflictingId,
    payload: `goodbye\n<!-- bountydesk-delivery:${conflictingId} -->`,
  };

  await assert.rejects(
    () => lifecycle.ensureInitialVerdict(conflicting),
    lifecycle.VerdictIntegrityError,
  );
});

test("ensureInitialVerdict compares summary and evidence on a retry", async () => {
  const reportId = await seedReport();
  const id = randomUUID();
  const input = {
    id,
    reportId,
    outcome: "ANALYSIS_ONLY" as const,
    summary: "original summary",
    evidence: { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" },
    payload: `analysis only\n<!-- bountydesk-delivery:${id} -->`,
  };
  await lifecycle.ensureInitialVerdict(input);

  await assert.rejects(
    () =>
      lifecycle.ensureInitialVerdict({ ...input, summary: "changed summary" }),
    /summary/,
  );
  await assert.rejects(
    () =>
      lifecycle.ensureInitialVerdict({
        ...input,
        evidence: { reason: "OTHER" },
      }),
    /evidence/,
  );
});
