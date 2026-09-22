import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * What a provider event is allowed to do to a report. The dangerous mistake this suite guards
 * against is treating acceptance as delivery: only `email.delivered` may complete a report, and
 * a bounce must leave it exactly where it was while flagging the outbox row for a human.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let receipts: typeof import("./receipts");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("email_receipts");

  dbm = await import("@/lib/db");
  receipts = await import("./receipts");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

/** A delivery the worker has already sent: SENT, stamped with the provider's id, report DELIVERING. */
async function seedSent(providerMessageId: string) {
  seq += 1;
  const n = seq;

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "email",
      sourceRef: `email:<receipt-${n}@mail.example>`,
      title: `report ${n}`,
      body: "body",
      state: "DELIVERING",
      reporterContact: "reporter@example.test",
      connectedRepositoryId: null,
      targetProfileId: null,
    })
    .returning({ id: dbm.report.id });

  const verdictId = randomUUID();
  const payload = `Analysis only.\n<!-- bountydesk-delivery:${verdictId} -->`;
  await dbm.db.insert(dbm.verdict).values({
    id: verdictId,
    reportId: r.id,
    outcome: "ANALYSIS_ONLY",
    summary: "summary",
    payload,
    contentHash: `hash-${n}`,
  });

  const [d] = await dbm.db
    .insert(dbm.outboundDelivery)
    .values({
      reportId: r.id,
      verdictId,
      idempotencyKey: `verdict:${verdictId}`,
      target: "reporter@example.test",
      approvedContentHash: `hash-${n}`,
      state: "SENT",
      providerMessageId,
    })
    .returning({ id: dbm.outboundDelivery.id });

  return { reportId: r.id, deliveryId: d.id };
}

async function readRows(fixture: { reportId: string; deliveryId: string }) {
  const [delivery] = await dbm.db
    .select()
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.id, fixture.deliveryId));
  const [reportRow] = await dbm.db
    .select()
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, fixture.reportId));
  const events = await dbm.db
    .select({ type: dbm.sessionEvent.type })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, fixture.reportId));
  return { delivery, report: reportRow, events };
}

function event(type: string, emailId: string, data: Record<string, unknown> = {}) {
  return { type, data: { email_id: emailId, ...data } };
}

test("a delivered receipt is what moves the report to DELIVERED", async () => {
  const fixture = await seedSent("re_delivered_1");

  const result = await receipts.applyDeliveryReceipt(event("email.delivered", "re_delivered_1"));
  assert.equal(result.handled, true);

  const { report, delivery } = await readRows(fixture);
  assert.equal(report.state, "DELIVERED");
  assert.ok(delivery.deliveredAt);
});

test("replaying the same delivered receipt is a no-op", async () => {
  const fixture = await seedSent("re_delivered_2");
  await receipts.applyDeliveryReceipt(event("email.delivered", "re_delivered_2"));
  await receipts.applyDeliveryReceipt(event("email.delivered", "re_delivered_2"));

  const { report, events } = await readRows(fixture);
  assert.equal(report.state, "DELIVERED");
  // A provider retry must not double the audit trail: recordEvent is keyed on the event id.
  assert.equal(events.filter((e) => e.type === "delivery.delivered").length, 1);
});

test("email.sent is acceptance, not delivery, and never completes a report", async () => {
  const fixture = await seedSent("re_sent_1");

  await receipts.applyDeliveryReceipt(event("email.sent", "re_sent_1"));

  const { report, delivery } = await readRows(fixture);
  assert.equal(report.state, "DELIVERING");
  assert.equal(delivery.requiresHumanReview, false);
});

test("a bounce holds the delivery and leaves the report where it was", async () => {
  const fixture = await seedSent("re_bounced_1");

  await receipts.applyDeliveryReceipt(
    event("email.bounced", "re_bounced_1", {
      bounce: { type: "Permanent", subType: "General", message: "mailbox does not exist" },
    }),
  );

  const { report, delivery } = await readRows(fixture);
  assert.equal(report.state, "DELIVERING", "a bounce is not a report-lifecycle event");
  assert.equal(delivery.state, "FAILED");
  assert.equal(delivery.requiresHumanReview, true);
  assert.match(delivery.lastError ?? "", /mailbox does not exist/);
});

test("a complaint flags the row but leaves the delivery SENT: it did arrive", async () => {
  const fixture = await seedSent("re_complained_1");
  await receipts.applyDeliveryReceipt(event("email.delivered", "re_complained_1"));

  await receipts.applyDeliveryReceipt(event("email.complained", "re_complained_1"));

  const { report, delivery } = await readRows(fixture);
  assert.equal(report.state, "DELIVERED");
  assert.equal(delivery.state, "SENT");
  assert.equal(delivery.requiresHumanReview, true);
});

test("a receipt for a message we never sent is ignored, not errored", async () => {
  const result = await receipts.applyDeliveryReceipt(event("email.delivered", "re_not_ours"));
  assert.equal(result.handled, false);
});

test("a delivered receipt cannot resurrect a report that has moved on", async () => {
  const fixture = await seedSent("re_cancelled_1");
  await dbm.db
    .update(dbm.report)
    .set({ state: "CANCELLED" })
    .where(dbm.eq(dbm.report.id, fixture.reportId));

  const result = await receipts.applyDeliveryReceipt(event("email.delivered", "re_cancelled_1"));
  assert.equal(result.handled, true);

  const { report } = await readRows(fixture);
  assert.equal(report.state, "CANCELLED");
});

test("an event type we have no opinion about is ignored, never guessed at", async () => {
  const fixture = await seedSent("re_unknown_1");

  // Resend adds event types over time, and an endpoint can be subscribed to one by mistake.
  // Neither may move a report or touch the outbox row.
  for (const type of ["email.opened", "email.clicked", "contact.created"]) {
    const result = await receipts.applyDeliveryReceipt({
      type,
      data: { email_id: "re_unknown_1" },
    });
    assert.equal(result.handled, false, `${type} must not be acted on`);
  }

  const { report, delivery, events } = await readRows(fixture);
  assert.equal(report.state, "DELIVERING");
  assert.equal(delivery.state, "SENT");
  assert.equal(events.length, 0);
});

test("a receipt with no email id is ignored: there is nothing to correlate", async () => {
  const result = await receipts.applyDeliveryReceipt({ type: "email.delivered", data: {} });
  assert.equal(result.handled, false);
});
