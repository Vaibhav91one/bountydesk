import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Real Postgres, disposable schema: the compare-and-swap in transition() and the append-only
 * session_event trigger are database guarantees, and a test that faked them would not be testing
 * the thing that makes this script safe to point at production.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

type DbModule = typeof import("@/lib/db");
type RetireModule = typeof import("./retire");

let dbm: DbModule;
let retire: RetireModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("reports_retire");
  dbm = await import("@/lib/db");
  retire = await import("./retire");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function seedReport(state: "TRIAGING" | "AWAITING_APPROVAL" | "DELIVERED"): Promise<string> {
  seq += 1;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:1:issue:${seq}`,
      title: `report ${seq}`,
      body: "body",
      state,
    })
    .returning({ id: dbm.report.id });
  return row.id;
}

async function stateOf(id: string) {
  const [row] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, id));
  return row.state;
}

async function events(id: string) {
  return dbm.db
    .select({ type: dbm.sessionEvent.type, data: dbm.sessionEvent.data })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, id));
}

test("a dry run reports what it would do and writes nothing", async () => {
  const id = await seedReport("AWAITING_APPROVAL");

  const outcomes = await retire.retireReports([id], { reason: "smoke test" });

  assert.deepEqual(outcomes, [{ reportId: id, status: "would-retire", from: "AWAITING_APPROVAL" }]);
  assert.equal(await stateOf(id), "AWAITING_APPROVAL");
  assert.deepEqual(await events(id), []);
});

test("committing moves the report and records why", async () => {
  const id = await seedReport("TRIAGING");

  const outcomes = await retire.retireReports([id], { reason: "left over from a smoke run", commit: true });

  assert.deepEqual(outcomes, [{ reportId: id, status: "retired", from: "TRIAGING" }]);
  assert.equal(await stateOf(id), "CANCELLED");
  const [event] = await events(id);
  assert.equal(event.type, "report.retired");
  assert.deepEqual(event.data, {
    from: "TRIAGING",
    to: "CANCELLED",
    reason: "left over from a smoke run",
  });
});

test("a report that already finished is skipped, not rewritten", async () => {
  const id = await seedReport("DELIVERED");

  const outcomes = await retire.retireReports([id], { reason: "smoke test", commit: true });

  assert.deepEqual(outcomes, [{ reportId: id, status: "already-terminal", from: "DELIVERED" }]);
  assert.equal(await stateOf(id), "DELIVERED");
  assert.deepEqual(await events(id), []);
});

test("an id that is not a report is reported rather than silently ignored", async () => {
  const missing = "00000000-0000-0000-0000-000000000000";

  const outcomes = await retire.retireReports([missing], { reason: "smoke test", commit: true });

  assert.deepEqual(outcomes, [{ reportId: missing, status: "missing" }]);
});

test("EXPIRED is available for a report abandoned rather than called off", async () => {
  const id = await seedReport("TRIAGING");

  await retire.retireReports([id], { reason: "reporter never replied", to: "EXPIRED", commit: true });

  assert.equal(await stateOf(id), "EXPIRED");
});

test("one report per transaction: a live report is still retired alongside a finished one", async () => {
  const finished = await seedReport("DELIVERED");
  const live = await seedReport("TRIAGING");

  const outcomes = await retire.retireReports([finished, live], { reason: "smoke test", commit: true });

  assert.deepEqual(outcomes.map((o) => o.status), ["already-terminal", "retired"]);
  assert.equal(await stateOf(live), "CANCELLED");
});
