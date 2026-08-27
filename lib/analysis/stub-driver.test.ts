import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

/**
 * Runs against a real Postgres, same as lib/jobs/queue.test.ts and lib/verdicts/lifecycle.test.ts:
 * the idempotency under test rests on a row lock and a unique index, not on anything a mock
 * could stand in for.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

type DbModule = typeof import("@/lib/db");
type DriverModule = typeof import("./stub-driver");
type HashModule = typeof import("@/lib/verdicts/hash");

let dbm: DbModule;
let driver: DriverModule;
let hash: HashModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("stub_driver");

  dbm = await import("@/lib/db");
  driver = await import("./stub-driver");
  hash = await import("@/lib/verdicts/hash");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

async function seedReport(state: "TRIAGING" | "REPRODUCING" = "TRIAGING"): Promise<string> {
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
      state,
    })
    .returning({ id: dbm.report.id });
  return row.id;
}

function context(reportId: string, signal: AbortSignal = new AbortController().signal) {
  return { reportId, lease: {} as never, signal };
}

test("a fresh TRIAGING report ends in AWAITING_APPROVAL with an ANALYSIS_ONLY verdict", async () => {
  const reportId = await seedReport("TRIAGING");

  await driver.stubAnalysisDriver.run(context(reportId));

  const [verdictRow] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));

  assert.equal(verdictRow.outcome, "ANALYSIS_ONLY");
  assert.match(verdictRow.payload, /bountydesk-delivery:/);
  assert.ok(
    verdictRow.payload.includes(`bountydesk-delivery:${verdictRow.id}`),
    "the marker must reference the verdict's own id",
  );
  assert.equal(verdictRow.contentHash, hash.computeContentHash(verdictRow.payload));

  const [reportRow] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportId));
  assert.equal(reportRow.state, "AWAITING_APPROVAL");
});

test("never produces REPRODUCED, NOT_REPRODUCED, or INCONCLUSIVE", async () => {
  const reportId = await seedReport("TRIAGING");
  await driver.stubAnalysisDriver.run(context(reportId));

  const [verdictRow] = await dbm.db
    .select({ outcome: dbm.verdict.outcome })
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));

  assert.equal(verdictRow.outcome, "ANALYSIS_ONLY");
});

test("running a second time on an already-processed report is a no-op", async () => {
  const reportId = await seedReport("TRIAGING");
  await driver.stubAnalysisDriver.run(context(reportId));

  await driver.stubAnalysisDriver.run(context(reportId));

  const rows = await dbm.db
    .select({ id: dbm.verdict.id })
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(rows.length, 1, "a re-run must not create a second verdict row");

  const [reportRow] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportId));
  assert.equal(reportRow.state, "AWAITING_APPROVAL");
});

test("a report starting in REPRODUCING also lands in AWAITING_APPROVAL", async () => {
  const reportId = await seedReport("REPRODUCING");
  await driver.stubAnalysisDriver.run(context(reportId));

  const [reportRow] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportId));
  assert.equal(reportRow.state, "AWAITING_APPROVAL");

  const [verdictRow] = await dbm.db
    .select({ outcome: dbm.verdict.outcome })
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(verdictRow.outcome, "ANALYSIS_ONLY");
});

test("an already-aborted signal throws its reason and touches nothing", async () => {
  const reportId = await seedReport("TRIAGING");
  const controller = new AbortController();
  const reason = new Error("lease lost");
  controller.abort(reason);

  await assert.rejects(
    () => driver.stubAnalysisDriver.run(context(reportId, controller.signal)),
    (error: unknown) => error === reason,
  );

  const rows = await dbm.db
    .select({ id: dbm.verdict.id })
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(rows.length, 0);

  const [reportRow] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportId));
  assert.equal(reportRow.state, "TRIAGING");
});
