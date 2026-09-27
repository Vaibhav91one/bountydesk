import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Notices against a real Postgres, because sendNotice reads the report row and writes the
 * "already sent" audit event. The send function is stubbed, so each case sees the exact subject,
 * body and headers that would go to Resend without mailing anyone. What must hold: a notice threads
 * under the reporter's own message and names the reporter's own report, never another one, and the
 * body stays the fixed constant.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let notice: typeof import("./notice");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("email_notice");

  dbm = await import("@/lib/db");
  notice = await import("./notice");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

type SendCall = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  idempotencyKey: string;
  headers?: Record<string, string>;
};

function stubSend() {
  const calls: SendCall[] = [];
  const send = (async (call: SendCall) => {
    calls.push(call);
    return { id: `re_${calls.length}` };
  }) as unknown as import("./notice").SendNotice;
  return { calls, send };
}

let seq = 0;

/** Insert an email report with a verified sender that a notice will reply to. */
async function emailReport(opts: { title: string; from?: string } = { title: "Stored XSS" }) {
  seq += 1;
  const from = opts.from ?? `reporter${seq}@outside.test`;
  const messageId = `<notice-${seq}@mail.test>`;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "email",
      sourceRef: `email:${messageId}`,
      title: opts.title,
      body: "the review form runs script tags",
      reporterContact: from,
      verifiedSender: from,
      state: "NEEDS_DECISION",
    })
    .returning({ id: dbm.report.id });
  return { id: row.id, from, messageId };
}

test("the acknowledgement threads under the reporter's message and its subject names their report", async () => {
  const report = await emailReport({ title: "Stored XSS in the review form" });
  const mail = stubSend();

  const result = await notice.sendNotice(report.id, "acknowledgement", mail.send);

  assert.equal(result.status, "sent");
  assert.equal(mail.calls.length, 1);
  const call = mail.calls[0];
  assert.equal(call.to, report.from);
  // Subject references the reporter's own report, as a reply.
  assert.equal(call.subject, "Re: Stored XSS in the review form");
  // Threaded onto the inbound message, the same way verdict delivery threads.
  assert.equal(call.headers?.["In-Reply-To"], report.messageId);
  assert.equal(call.headers?.["References"], report.messageId);
  // The body is the fixed acknowledgement, unchanged.
  assert.equal(call.text, notice.NOTICES.acknowledgement.text);
  assert.equal(call.html, undefined);
});

test("the duplicate reply names the reporter's own report but never the original", async () => {
  const original = await emailReport({ title: "Someone else's SQL injection report" });
  const reporter = await emailReport({ title: "SQL injection in product search" });
  const mail = stubSend();

  const result = await notice.sendNotice(reporter.id, "duplicate", mail.send);

  assert.equal(result.status, "sent");
  const call = mail.calls[0];
  // References the reporter's own submission.
  assert.equal(call.subject, "Re: SQL injection in product search");
  // Says nothing about the original: not its id, not its title.
  assert.ok(!call.subject.includes(original.id));
  assert.ok(!call.subject.includes("Someone else"));
  assert.ok(!call.text.includes(original.id));
  assert.ok(!call.text.includes("Someone else"));
  assert.equal(call.text, notice.NOTICES.duplicate.text);
});

test("a report with no verified sender gets no notice", async () => {
  // Allowlisted senders have no verified_sender, so nothing is safe to reply to at the gate.
  seq += 1;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "email",
      sourceRef: `email:<no-verify-${seq}@mail.test>`,
      title: "no verified sender",
      body: "x",
      reporterContact: "owner@bountydesk.test",
      verifiedSender: null,
      state: "NEEDS_DECISION",
    })
    .returning({ id: dbm.report.id });
  const mail = stubSend();

  const result = await notice.sendNotice(row.id, "acknowledgement", mail.send);

  assert.equal(result.status, "refused");
  assert.equal(mail.calls.length, 0);
});

test("the oversized-drop notice threads under the message and carries the fixed body", async () => {
  const mail = stubSend();

  const result = await notice.sendOversizedNotice(
    { messageId: "<big-1@mail.test>", fromEmail: "Big@Sender.Test", subject: "Huge XSS proof" },
    mail.send,
  );

  assert.equal(result.status, "sent");
  const call = mail.calls[0];
  assert.equal(call.to, "big@sender.test");
  assert.equal(call.subject, "Re: Huge XSS proof");
  assert.equal(call.headers?.["In-Reply-To"], "<big-1@mail.test>");
  assert.equal(call.idempotencyKey, "notice:oversized:<big-1@mail.test>");
  assert.equal(call.text, notice.NOTICES.oversized.text);
});
