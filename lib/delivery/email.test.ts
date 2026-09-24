import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The email arm, against a real Postgres because everything that makes it safe is a row: the
 * lease fence, the `provider_message_id` stamp that proves bytes already went out, and the
 * report state that must not move on a mere provider acceptance. The transport is faked so a
 * crash between the 200 and the stamp can be forced deterministically.
 */
const OWNER = "reporter@bountydesk.test";
process.env.REVIEWER_EMAILS = OWNER;

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let worker: typeof import("./worker");
let emailArmModule: typeof import("./email");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("delivery_email");

  dbm = await import("@/lib/db");
  worker = await import("./worker");
  emailArmModule = await import("./email");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function fakeHash(payload: string): string {
  return `fake-hash:${payload.length}:${payload.slice(0, 12)}`;
}

let seq = 0;

/**
 * An email report: no installation, no connected repository, no target profile. That is the
 * shape the channel actually produces, and it is deliberately what these tests deliver from,
 * because a GitHub-flavoured fixture would hide a dependency the email arm must not have.
 */
async function seedEmailFixture(
  opts: {
    reporterContact?: string | null;
    targetOverride?: string;
    providerMessageId?: string;
    createdAt?: Date;
    title?: string;
    payloadExtra?: string;
    verifiedSender?: string | null;
  } = {},
) {
  seq += 1;
  const n = seq;
  const contact = opts.reporterContact === undefined ? OWNER : opts.reporterContact;
  const sourceRef = `email:<msg-${n}@mail.example>`;

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "email",
      sourceRef,
      title: opts.title ?? `report ${n}`,
      body: "steps to reproduce",
      state: "DELIVERING",
      reporterContact: contact,
      verifiedSender: opts.verifiedSender ?? null,
      connectedRepositoryId: null,
      targetProfileId: null,
    })
    .returning({ id: dbm.report.id });

  const verdictId = randomUUID();
  const marker = `<!-- bountydesk-delivery:${verdictId} -->`;
  const payload = `Analysis only.${opts.payloadExtra ?? ""}\n${marker}`;
  const contentHash = fakeHash(payload);

  await dbm.db.insert(dbm.verdict).values({
    id: verdictId,
    reportId: r.id,
    outcome: "ANALYSIS_ONLY",
    summary: "summary",
    payload,
    contentHash,
  });
  await dbm.db.insert(dbm.approvalDecision).values({
    verdictId,
    reviewer: "test-reviewer",
    decision: "APPROVED",
    payloadHash: contentHash,
  });

  const [d] = await dbm.db
    .insert(dbm.outboundDelivery)
    .values({
      reportId: r.id,
      verdictId,
      idempotencyKey: `verdict:${verdictId}`,
      target: opts.targetOverride ?? (contact ?? "nobody@example.test"),
      approvedContentHash: contentHash,
      ...(opts.providerMessageId ? { providerMessageId: opts.providerMessageId } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning({ id: dbm.outboundDelivery.id });

  return { reportId: r.id, verdictId, deliveryId: d.id, payload, marker, sourceRef };
}

/** claim() inside deliverOnce is global; retire every other row first (see queue.test.ts). */
async function drainOthers() {
  await dbm.db
    .update(dbm.outboundDelivery)
    .set({ state: "SENT", leaseOwner: null, leaseExpiresAt: null });
}

type SendCall = Parameters<import("./arm").DeliveryDeps["sendEmail"]>[0];

function makeDeps(send?: (call: number, opts: SendCall) => Promise<{ id: string }>) {
  const sent: SendCall[] = [];
  const deps: import("./arm").DeliveryDeps = {
    githubAppId: 123456,
    hashContent: fakeHash,
    // The email arm must never reach the GitHub transport, so every GitHub dep throws. That
    // turns the required fields into assertions rather than dead scaffolding.
    mintToken: async () => {
      throw new Error("email delivery must not mint a GitHub token");
    },
    postComment: async () => {
      throw new Error("email delivery must not post a comment");
    },
    listComments: async () => {
      throw new Error("email delivery must not read comments");
    },
    sendEmail: async (opts) => {
      sent.push(opts);
      if (send) return send(sent.length, opts);
      return { id: `re_${sent.length}_${randomUUID().slice(0, 8)}` };
    },
  };
  return { deps, sent };
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
  return { delivery, report: reportRow };
}

test("a provider 200 earns SENT but never DELIVERED", async () => {
  await drainOthers();
  const fixture = await seedEmailFixture();
  const { deps, sent } = makeDeps();

  const claimed = await worker.deliverOnce("w-email", { deps });
  assert.equal(claimed, fixture.deliveryId);
  assert.equal(sent.length, 1);

  const { delivery, report } = await readRows(fixture);
  assert.equal(delivery.state, "SENT");
  assert.ok(delivery.providerMessageId, "the provider's id is stamped on the row");
  // The whole point of the split: acceptance by Resend is not a receipt from the recipient.
  assert.equal(report.state, "DELIVERING");
  // SENT with a null delivered_at is the observable "sent, still waiting to hear" state. Stamping
  // it here would claim a delivery on the strength of the provider accepting the call.
  assert.equal(delivery.deliveredAt, null);
});

test("a recipient removed from the allowlist is refused and held, with nothing sent", async () => {
  await drainOthers();
  const stranger = "gone@example.test";
  const fixture = await seedEmailFixture({ reporterContact: stranger });
  const { deps, sent } = makeDeps();

  await worker.deliverOnce("w-email", { deps });

  assert.equal(sent.length, 0, "no mail to an address that lost authorization");
  const { delivery, report } = await readRows(fixture);
  assert.equal(delivery.state, "FAILED");
  assert.equal(delivery.requiresHumanReview, true);
  assert.equal(report.state, "DELIVERING");
});

test("an outside sender that passed SPF and DKIM at intake is a valid recipient", async () => {
  await drainOthers();
  const outsider = "researcher@outside.test";
  const fixture = await seedEmailFixture({ reporterContact: outsider, verifiedSender: outsider });
  const { deps, sent } = makeDeps();

  await worker.deliverOnce("w-email", { deps });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, outsider);
  const { delivery } = await readRows(fixture);
  assert.equal(delivery.state, "SENT");
});

test("an outside contact that no longer matches the verified sender is refused and held", async () => {
  await drainOthers();
  // The report's contact was changed after intake: the SPF/DKIM proof was for another address.
  const fixture = await seedEmailFixture({
    reporterContact: "victim@elsewhere.test",
    verifiedSender: "researcher@outside.test",
  });
  const { deps, sent } = makeDeps();

  await worker.deliverOnce("w-email", { deps });

  assert.equal(sent.length, 0);
  const { delivery } = await readRows(fixture);
  assert.equal(delivery.state, "FAILED");
  assert.equal(delivery.requiresHumanReview, true);
});

test("a verification cleared after approval stops the send", async () => {
  await drainOthers();
  const outsider = "researcher2@outside.test";
  const fixture = await seedEmailFixture({ reporterContact: outsider, verifiedSender: outsider });
  // The send-time check reads the row as it is now, not the approval-time snapshot.
  await dbm.db
    .update(dbm.report)
    .set({ verifiedSender: null })
    .where(dbm.eq(dbm.report.id, fixture.reportId));
  const { deps, sent } = makeDeps();

  await worker.deliverOnce("w-email", { deps });

  assert.equal(sent.length, 0);
  const { delivery } = await readRows(fixture);
  assert.equal(delivery.state, "FAILED");
});

test("a report whose contact moved since approval is refused, with nothing sent", async () => {
  await drainOthers();
  // Approved to go to one address, the report now names another: not the delivery a human saw.
  const fixture = await seedEmailFixture({ targetOverride: "someone-else@bountydesk.test" });
  const { deps, sent } = makeDeps();

  await worker.deliverOnce("w-email", { deps });

  assert.equal(sent.length, 0);
  const { delivery } = await readRows(fixture);
  assert.equal(delivery.state, "FAILED");
});

test("a report with no verified contact is refused, with nothing sent", async () => {
  await drainOthers();
  const fixture = await seedEmailFixture({ reporterContact: null });
  const { deps, sent } = makeDeps();

  await worker.deliverOnce("w-email", { deps });

  assert.equal(sent.length, 0);
  const { delivery } = await readRows(fixture);
  assert.equal(delivery.state, "FAILED");
});

test("a row that already carries a provider message id is replayed, not re-sent", async () => {
  await drainOthers();
  const fixture = await seedEmailFixture({ providerMessageId: "re_already_sent" });
  const { deps, sent } = makeDeps();

  await worker.deliverOnce("w-email", { deps });

  assert.equal(sent.length, 0, "the stamp is the proof bytes already went out");
  const { delivery, report } = await readRows(fixture);
  assert.equal(delivery.state, "SENT");
  assert.equal(delivery.providerMessageId, "re_already_sent");
  assert.equal(report.state, "DELIVERING");
});

test("a retry outside the provider's idempotency window refuses rather than risk a second mail", async () => {
  await drainOthers();
  const fixture = await seedEmailFixture({
    createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
  });
  const { deps, sent } = makeDeps();

  await worker.deliverOnce("w-email", { deps });

  assert.equal(sent.length, 0);
  const { delivery } = await readRows(fixture);
  assert.equal(delivery.state, "FAILED");
  assert.equal(delivery.requiresHumanReview, true);
});

test("a retry after a crash sends a byte-identical request under the same idempotency key", async () => {
  await drainOthers();
  const fixture = await seedEmailFixture();
  // First attempt: the provider accepts, then the process dies before the stamp commits.
  const crash = makeDeps(async () => {
    throw new Error("connection reset after the provider accepted");
  });
  await worker.deliverOnce("w-email", { deps: crash.deps });
  assert.equal(crash.sent.length, 1);

  // Make the row claimable again rather than waiting out the backoff.
  await dbm.db
    .update(dbm.outboundDelivery)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.outboundDelivery.id, fixture.deliveryId));

  const retry = makeDeps();
  await worker.deliverOnce("w-email", { deps: retry.deps });
  assert.equal(retry.sent.length, 1);

  // Resend can only recognise the replay if every byte matches, which is why nothing in the
  // request may depend on the attempt number or the clock.
  assert.deepEqual(retry.sent[0], crash.sent[0]);
  assert.equal(retry.sent[0].idempotencyKey, `verdict:${fixture.verdictId}`);
});

test("the sent body is the approved payload, and its HTML part escapes markup", async () => {
  await drainOthers();
  const fixture = await seedEmailFixture({
    payloadExtra: " Try <script>alert(1)</script> and a & b.",
  });
  const { deps, sent } = makeDeps();

  await worker.deliverOnce("w-email", { deps });

  assert.equal(sent[0].text, fixture.payload, "the text part is the approved bytes, verbatim");
  assert.ok(!sent[0].html.includes("<script>"), "markup from the payload is never live in a mailbox");
  assert.ok(sent[0].html.includes("&lt;script&gt;"));
  // The marker is deliberately put back as raw HTML so it stays an auditable, invisible comment.
  assert.ok(sent[0].html.includes(fixture.marker));
  assert.equal(sent[0].html.split(fixture.marker).length, 2, "exactly one marker");
});

test("a reporter-controlled subject cannot inject a header", () => {
  const subject = emailArmModule.emailSubject("Bug\r\nBcc: attacker@example.test");
  assert.ok(!/[\r\n]/.test(subject));
  assert.equal(subject, "Re: Bug Bcc: attacker@example.test");
});

test("the reply threads onto the reporter's message, and only on a real message id", () => {
  assert.deepEqual(emailArmModule.threadingHeaders("email:<abc@mail.example>"), {
    "In-Reply-To": "<abc@mail.example>",
    References: "<abc@mail.example>",
  });
  // A synthesised Message-ID is worse than none: it threads the reply onto a stranger's mail.
  assert.equal(emailArmModule.threadingHeaders("email:not-a-message-id"), undefined);
  assert.equal(emailArmModule.threadingHeaders("github:1:issue:2"), undefined);
});
