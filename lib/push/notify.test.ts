import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, beforeEach, mock } from "node:test";

mock.module("@/lib/auth/reviewers", {
  namedExports: {
    isReviewerEmail: async (email: string | null | undefined) => {
      const normalized = (email ?? "").trim().toLowerCase();
      return normalized === "alice@bountydesk.test";
    },
  },
});

const TOKEN = "ExponentPushToken[abcdef0123456789_-]";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let notify: typeof import("./notify");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("push-notify");
  dbm = await import("@/lib/db");
  notify = await import("./notify");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

beforeEach(async () => {
  // TRUNCATE (not DELETE) because report, verdict, and notification_event are append-only:
  // their row-level triggers refuse DELETE. TRUNCATE does not fire triggers and resets the
  // schema to a clean slate for each test. CASCADE handles FK references from outbound_delivery
  // to verdict and report.
  await dbm.db.execute("truncate notification_event, outbound_delivery, device_push_token, verdict cascade");
});

async function seedReport(state: "AWAITING_APPROVAL" | "DELIVERED") {
  const reportId = randomUUID();
  await dbm.db.insert(dbm.report).values({
    id: reportId,
    channel: "email",
    sourceRef: `email:researcher@${reportId}.example`,
    title: "Test report",
    body: "body",
    state,
  });

  const sourceLabel = `#${reportId.slice(0, 8)}`;

  if (state === "AWAITING_APPROVAL") {
    const verdictId = randomUUID();
    await dbm.db.insert(dbm.verdict).values({
      id: verdictId,
      reportId,
      outcome: "INCONCLUSIVE",
      summary: "summary",
      payload: "payload",
      contentHash: "hash",
    });
    return { reportId, sourceLabel, verdictId };
  }

  // DELIVERED: needs a verdict and an outbound_delivery.
  const verdictId = randomUUID();
  await dbm.db.insert(dbm.verdict).values({
    id: verdictId,
    reportId,
    outcome: "INCONCLUSIVE",
    summary: "summary",
    payload: "payload",
    contentHash: "hash",
  });

  const deliveryId = randomUUID();
  await dbm.db.insert(dbm.outboundDelivery).values({
    id: deliveryId,
    reportId,
    verdictId,
    state: "SENT",
    idempotencyKey: `idem-${reportId}`,
    target: "github:1:issue:1",
    approvedContentHash: "hash",
    deliveredAt: new Date(),
  });

  return { reportId, sourceLabel, deliveryId };
}

async function registerToken(email: string, token: string = TOKEN) {
  await dbm.db.insert(dbm.devicePushToken).values({
    token,
    reviewerEmail: email,
    platform: "ios",
  });
}

type SentMsg = { to: string; title: string; body: string; data: Record<string, unknown> };

test("an AWAITING_APPROVAL report with a verdict sends one message with the sourceLabel body", async () => {
  const { reportId, sourceLabel } = await seedReport("AWAITING_APPROVAL");
  await registerToken("alice@bountydesk.test");

  const sent: SentMsg[] = [];
  const fakeSend = async (messages: SentMsg[]) => {
    sent.push(...messages);
    return messages.map((_, i) => ({ id: `ticket-${i}` }));
  };

  const result = await notify.sweepPushNotifications({ send: fakeSend, now: new Date() });
  assert.equal(result.sent, 1, `expected 1 sent, got ${result.sent}`);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, TOKEN);
  assert.equal(sent[0].title, "Verdict awaiting approval");
  assert.equal(sent[0].body, sourceLabel);
  assert.deepEqual(sent[0].data, { reportId, screen: "sign" });
});

test("a second sweep sends nothing", async () => {
  const { reportId } = await seedReport("AWAITING_APPROVAL");
  await registerToken("alice@bountydesk.test");

  const sent: unknown[] = [];
  const fakeSend = async (messages: unknown[]) => {
    sent.push(...messages);
    return messages.map((_, i) => ({ id: `ticket-${i}` }));
  };

  const first = await notify.sweepPushNotifications({ send: fakeSend, now: new Date() });
  assert.equal(first.sent, 1);
  assert.equal(sent.length, 1);

  const second = await notify.sweepPushNotifications({ send: fakeSend, now: new Date() });
  assert.equal(second.sent, 0);
  assert.equal(sent.length, 1, "the second sweep sent nothing");

  // The notification_event row was created on the first pass.
  const events = await dbm.db
    .select()
    .from(dbm.notificationEvent)
    .where(dbm.eq(dbm.notificationEvent.reportId, reportId));
  assert.equal(events.length, 1);
});

test("a token whose email is not a reviewer gets nothing", async () => {
  await seedReport("AWAITING_APPROVAL");

  // carol is not in the allowlist.
  await registerToken("carol@example.com");

  const sent: unknown[] = [];
  const fakeSend = async (messages: unknown[]) => {
    sent.push(...messages);
    return messages.map((_, i) => ({ id: `ticket-${i}` }));
  };

  const result = await notify.sweepPushNotifications({ send: fakeSend, now: new Date() });
  assert.equal(result.sent, 0);
  assert.equal(sent.length, 0);

  // No message was sent, so no notification_event row was created — the candidate is still
  // eligible next sweep if an allowlisted token registers later.
  assert.equal(result.candidates, 1);
});

test("DeviceNotRegistered revokes the token", async () => {
  await seedReport("AWAITING_APPROVAL");
  await registerToken("alice@bountydesk.test");

  const fakeSend = async () => [
    { id: "ticket-1", details: { error: "DeviceNotRegistered" } },
  ];

  const result = await notify.sweepPushNotifications({ send: fakeSend, now: new Date() });
  assert.equal(result.sent, 1);
  assert.equal(result.revoked, 1);

  const [row] = await dbm.db
    .select({ revokedAt: dbm.devicePushToken.revokedAt })
    .from(dbm.devicePushToken)
    .where(dbm.eq(dbm.devicePushToken.token, TOKEN));
  assert.ok(row.revokedAt !== null);
});

test("notification_event refuses UPDATE and DELETE", async () => {
  const { reportId, verdictId } = await seedReport("AWAITING_APPROVAL");
  await registerToken("alice@bountydesk.test");

  const fakeSend = async () => [{ id: "ticket-1" }];
  await notify.sweepPushNotifications({ send: fakeSend, now: new Date() });

  // The trigger must refuse an UPDATE on notification_event.
  await assert.rejects(
    () =>
      dbm.db
        .update(dbm.notificationEvent)
        .set({ kind: "DELIVERED" })
        .where(dbm.eq(dbm.notificationEvent.reportId, reportId)),
    (err: Error) => /append-only/i.test((err as { cause?: Error }).cause?.message ?? err.message),
  );

  // A DELETE must also be refused.
  await assert.rejects(
    () =>
      dbm.db.delete(dbm.notificationEvent).where(dbm.eq(dbm.notificationEvent.reportId, reportId)),
    (err: Error) => /append-only/i.test((err as { cause?: Error }).cause?.message ?? err.message),
  );

  // The ref_id must be the verdict id, not the delivery id.
  const [row] = await dbm.db
    .select({ refId: dbm.notificationEvent.refId, kind: dbm.notificationEvent.kind })
    .from(dbm.notificationEvent)
    .where(dbm.eq(dbm.notificationEvent.reportId, reportId));
  assert.equal(row.refId, verdictId);
  assert.equal(row.kind, "AWAITING_APPROVAL");
});

test("a DELIVERED report sends with the outbound delivery id as ref_id", async () => {
  const { reportId, deliveryId, sourceLabel } = await seedReport("DELIVERED");
  await registerToken("alice@bountydesk.test");

  const sent: SentMsg[] = [];
  const fakeSend = async (messages: SentMsg[]) => {
    sent.push(...messages);
    return messages.map((_, i) => ({ id: `ticket-${i}` }));
  };

  await notify.sweepPushNotifications({ send: fakeSend, now: new Date() });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Verdict delivered");
  assert.equal(sent[0].body, sourceLabel);
  assert.deepEqual(sent[0].data, { reportId, screen: "case" });

  // The notification_event row recorded the outbound delivery id as ref_id.
  const [row] = await dbm.db
    .select({ refId: dbm.notificationEvent.refId, kind: dbm.notificationEvent.kind })
    .from(dbm.notificationEvent)
    .where(dbm.eq(dbm.notificationEvent.reportId, reportId));
  assert.equal(row.refId, deliveryId);
  assert.equal(row.kind, "DELIVERED");
});

test("a second token for the same reviewer both get notified", async () => {
  await seedReport("AWAITING_APPROVAL");
  await registerToken("alice@bountydesk.test", "ExponentPushToken[token-one]");
  await registerToken("alice@bountydesk.test", "ExponentPushToken[token-two]");

  const sent: { to: string }[] = [];
  const fakeSend = async (messages: { to: string }[]) => {
    sent.push(...messages);
    return messages.map((_, i) => ({ id: `ticket-${i}` }));
  };

  const result = await notify.sweepPushNotifications({ send: fakeSend, now: new Date() });
  assert.equal(result.sent, 2);
  assert.deepEqual(
    sent.map((s) => s.to).sort(),
    ["ExponentPushToken[token-one]", "ExponentPushToken[token-two]"],
  );
});
