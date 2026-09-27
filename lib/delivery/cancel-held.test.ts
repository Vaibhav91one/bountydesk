import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Real Postgres, disposable schema: cancelHeldReport leans on transition()'s compare-and-swap and
 * the append-only session_event trigger through retireReports, and on claim()'s "not held" filter
 * through the delivery worker. A mock would agree with a broken version of any of those, so this
 * exercises the database guarantees the feature rests on.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

type DbModule = typeof import("@/lib/db");
type RetryModule = typeof import("./retry");
type WorkerModule = typeof import("./worker");

let dbm: DbModule;
let retry: RetryModule;
let worker: WorkerModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("delivery_cancel_held");
  dbm = await import("@/lib/db");
  retry = await import("./retry");
  worker = await import("./worker");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

type ReportState = "DELIVERING" | "DELIVERED";
type DeliveryOverrides = Partial<{
  state: "PENDING" | "SENT" | "FAILED";
  requiresHumanReview: boolean;
}>;

async function seed(reportState: ReportState, delivery: DeliveryOverrides = {}) {
  seq += 1;
  const n = seq;

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:1:issue:${n}`,
      title: `report ${n}`,
      body: "body",
      state: reportState,
    })
    .returning({ id: dbm.report.id });

  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: r.id,
      outcome: "REPRODUCED",
      summary: "summary",
      payload: `payload ${n}`,
      contentHash: `hash-${n}`,
    })
    .returning({ id: dbm.verdict.id });

  const [d] = await dbm.db
    .insert(dbm.outboundDelivery)
    .values({
      reportId: r.id,
      verdictId: v.id,
      idempotencyKey: `key-${n}`,
      target: `github:1:issue:${n}`,
      approvedContentHash: `hash-${n}`,
      state: delivery.state ?? "PENDING",
      requiresHumanReview: delivery.requiresHumanReview ?? false,
    })
    .returning({ id: dbm.outboundDelivery.id });

  return { reportId: r.id, deliveryId: d.id };
}

/** A report wedged in DELIVERING behind a delivery that failed and was held for review. */
function seedHeld() {
  return seed("DELIVERING", { state: "FAILED", requiresHumanReview: true });
}

async function stateOf(id: string) {
  const [row] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, id));
  return row.state;
}

async function deliveryRow(id: string) {
  const [row] = await dbm.db
    .select({
      state: dbm.outboundDelivery.state,
      requiresHumanReview: dbm.outboundDelivery.requiresHumanReview,
    })
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.id, id));
  return row;
}

/**
 * claim() and claimById() are global over the whole table, so a PENDING row left by another test
 * could be handed to deliverOnce and make "returns null" pass for the wrong reason. Parking every
 * other row as SENT leaves only the row under test claimable, or nothing.
 */
async function drainOthers() {
  await dbm.db
    .update(dbm.outboundDelivery)
    .set({ state: "SENT", leaseOwner: null, leaseExpiresAt: null });
}

test("a held delivery on a DELIVERING report cancels to CANCELLED and touches no outbox row", async () => {
  const { reportId, deliveryId } = await seedHeld();

  const result = await retry.cancelHeldReport(reportId, "alice");

  assert.deepEqual(result, { ok: true });
  assert.equal(await stateOf(reportId), "CANCELLED");

  const [event] = await dbm.db
    .select({ type: dbm.sessionEvent.type, data: dbm.sessionEvent.data })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, reportId));
  assert.equal(event.type, "report.retired");
  assert.match(String((event.data as { reason?: string }).reason ?? ""), /alice/);

  const row = await deliveryRow(deliveryId);
  assert.equal(row.state, "FAILED");
  assert.equal(row.requiresHumanReview, true);
});

test("the held row stays out of the delivery worker's reach after cancelling", async () => {
  await drainOthers();
  const { reportId } = await seedHeld();

  await retry.cancelHeldReport(reportId, "alice");

  assert.equal(await worker.deliverOnce("worker-after-cancel"), null);
});

test("a terminal report cannot be cancelled", async () => {
  const { reportId } = await seed("DELIVERED", { state: "SENT" });

  const result = await retry.cancelHeldReport(reportId, "alice");

  assert.deepEqual(result, { ok: false, reason: "report is already DELIVERED" });
  assert.equal(await stateOf(reportId), "DELIVERED");
});

test("a DELIVERING report whose delivery is not held is refused", async () => {
  const pending = await seed("DELIVERING", { state: "PENDING" });
  const failedUnheld = await seed("DELIVERING", { state: "FAILED", requiresHumanReview: false });

  assert.deepEqual(await retry.cancelHeldReport(pending.reportId, "alice"), {
    ok: false,
    reason: "this report has no held delivery to cancel",
  });
  assert.deepEqual(await retry.cancelHeldReport(failedUnheld.reportId, "alice"), {
    ok: false,
    reason: "this report has no held delivery to cancel",
  });
  assert.equal(await stateOf(pending.reportId), "DELIVERING");
  assert.equal(await stateOf(failedUnheld.reportId), "DELIVERING");
});

test("an id that is not a report reports missing", async () => {
  const missing = "00000000-0000-0000-0000-000000000000";

  assert.deepEqual(await retry.cancelHeldReport(missing, "alice"), {
    ok: false,
    reason: "report not found",
  });
});

test("cancel then retry: retry refuses the cancelled report and it stays CANCELLED", async () => {
  const { reportId } = await seedHeld();

  assert.deepEqual(await retry.cancelHeldReport(reportId, "alice"), { ok: true });

  const retried = await retry.retryHeldDelivery(reportId, "bob");
  assert.equal(retried.ok, false);
  assert.equal(await stateOf(reportId), "CANCELLED");
});

test("retry then cancel: a re-held delivery still cancels, and no later send goes out", async () => {
  await drainOthers();
  const { reportId, deliveryId } = await seedHeld();

  // Reviewer retries; the row goes back to PENDING for the worker to pick up.
  const retried = await retry.retryHeldDelivery(reportId, "bob");
  assert.equal(retried.ok, true);
  assert.equal((await deliveryRow(deliveryId)).state, "PENDING");

  // The retried send fails again and is re-held: the exact loop this feature breaks. The worker
  // does that through failPermanently; setting the terminal state directly keeps the test off a
  // live transport.
  await dbm.db
    .update(dbm.outboundDelivery)
    .set({ state: "FAILED", requiresHumanReview: true })
    .where(dbm.eq(dbm.outboundDelivery.id, deliveryId));

  assert.deepEqual(await retry.cancelHeldReport(reportId, "alice"), { ok: true });
  assert.equal(await stateOf(reportId), "CANCELLED");

  // A targeted drain finds nothing to send: the row is held and the report is terminal.
  assert.equal(await worker.deliverById(deliveryId, "worker-after-cancel"), null);
  assert.equal((await deliveryRow(deliveryId)).state, "FAILED");
});
