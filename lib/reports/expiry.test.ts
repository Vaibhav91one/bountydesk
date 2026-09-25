import assert from "node:assert/strict";
import test, { after, before } from "node:test";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let expiry: typeof import("./expiry");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("expiry");
  dbm = await import("@/lib/db");
  expiry = await import("./expiry");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let ids = 0;

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

async function seedReport(
  state: import("./states").ReportState,
  updatedAt: Date,
): Promise<string> {
  ids += 1;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "email",
      sourceRef: `email:expiry:${ids}`,
      title: "test report",
      body: "body",
      connectedRepositoryId: null,
      targetProfileId: null,
      state,
      updatedAt,
    })
    .returning({ id: dbm.report.id });
  return row.id;
}

async function stateOf(id: string): Promise<string> {
  const [row] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, id));
  return row.state;
}

test("expires abandoned reports, spares in-flight, running, and fresh ones", async () => {
  const oldNeedsDecision = await seedReport("NEEDS_DECISION", daysAgo(40));
  const oldTriaging = await seedReport("TRIAGING", daysAgo(40));
  const freshNeedsDecision = await seedReport("NEEDS_DECISION", daysAgo(1));
  const oldReproducing = await seedReport("REPRODUCING", daysAgo(40));

  // An old TRIAGING report with a live investigation must be spared despite its age.
  const oldTriagingWithSession = await seedReport("TRIAGING", daysAgo(40));
  await dbm.db.insert(dbm.agentSession).values({
    reportId: oldTriagingWithSession,
    capabilityToken: `cap-${ids}`,
    sessionId: `ses-${ids}`,
    turnStatus: "RUNNING",
  });

  const result = await expiry.sweepExpiredReports();

  assert.equal(result.candidates, 2, "only the two abandoned reports are candidates");
  assert.equal(
    result.outcomes.filter((o) => o.status === "retired").length,
    2,
  );

  assert.equal(await stateOf(oldNeedsDecision), "EXPIRED");
  assert.equal(await stateOf(oldTriaging), "EXPIRED");
  assert.equal(await stateOf(freshNeedsDecision), "NEEDS_DECISION", "under the TTL, untouched");
  assert.equal(await stateOf(oldReproducing), "REPRODUCING", "in flight, never expired");
  assert.equal(
    await stateOf(oldTriagingWithSession),
    "TRIAGING",
    "a live session spares an old report",
  );

  // Records the move as a session_event on the report.
  const events = await dbm.db
    .select({ type: dbm.sessionEvent.type, data: dbm.sessionEvent.data })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, oldNeedsDecision));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "report.retired");
  assert.equal((events[0].data as { to: string }).to, "EXPIRED");
});

test("running the sweep again expires nothing already moved", async () => {
  const result = await expiry.sweepExpiredReports();
  assert.equal(result.candidates, 0, "idempotent: no fresh candidates remain");
});

test("commit:false reports would-expire without moving the report", async () => {
  const old = await seedReport("NEEDS_DECISION", daysAgo(40));

  const result = await expiry.sweepExpiredReports({ commit: false });

  assert.equal(result.candidates, 1);
  assert.equal(result.outcomes[0].status, "would-retire");
  assert.equal(await stateOf(old), "NEEDS_DECISION", "dry run leaves the state alone");
});
