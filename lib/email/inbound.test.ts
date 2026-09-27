import assert from "node:assert/strict";
import test from "node:test";

import { Webhook } from "svix";

import {
  parseInboundEmail,
  parseThreadReferences,
  verifyResendWebhook,
  type ResendWebhookEvent,
} from "./inbound";

const SECRET = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;

function received(data: Record<string, unknown>): ResendWebhookEvent {
  return { type: "email.received", data };
}

test("a From with a display name splits into a lowercased address and name", () => {
  const email = parseInboundEmail(
    received({ from: "Ada Lovelace <Ada@Example.com>", subject: "XSS in search", text: "steps", message_id: "m1" }),
  );
  assert.equal(email?.fromEmail, "ada@example.com");
  assert.equal(email?.fromName, "Ada Lovelace");
  assert.equal(email?.subject, "XSS in search");
  assert.equal(email?.text, "steps");
  assert.equal(email?.messageId, "m1");
});

test("the Resend email id is captured separately from the RFC message id", () => {
  // Mirrors the real payload: message_id is the RFC id (idempotency), email_id is Resend's own id
  // (used to fetch the body). They must not be conflated.
  const email = parseInboundEmail(
    received({ from: "a@b.com", message_id: "<x@mail.gmail.com>", email_id: "f6a0c446-1234", text: "hi" }),
  );
  assert.equal(email?.messageId, "<x@mail.gmail.com>");
  assert.equal(email?.resendEmailId, "f6a0c446-1234");
});

test("resendEmailId is null when the event carries no Resend id", () => {
  assert.equal(parseInboundEmail(received({ from: "a@b.com", message_id: "m7" }))?.resendEmailId, null);
});

test("a bare address and an object From both resolve", () => {
  assert.equal(parseInboundEmail(received({ from: "bare@example.com", message_id: "m2" }))?.fromEmail, "bare@example.com");
  assert.equal(
    parseInboundEmail(received({ from: { address: "OBJ@example.com", name: "Obj" }, message_id: "m3" }))?.fromEmail,
    "obj@example.com",
  );
});

test("no sender, no message id, or a non-received event yields null", () => {
  assert.equal(parseInboundEmail(received({ from: "not-an-email", message_id: "m4" })), null);
  assert.equal(parseInboundEmail(received({ from: "x@example.com" })), null);
  assert.equal(parseInboundEmail({ type: "email.delivered", data: {} }), null);
});

test("a missing subject or body falls back rather than crashing", () => {
  const email = parseInboundEmail(received({ from: "a@b.com", message_id: "m5" }));
  assert.equal(email?.subject, "(no subject)");
  assert.equal(email?.text, "");
});

test("thread references are read from In-Reply-To and References, deduped", () => {
  const headers = [
    "From: reporter@example.com",
    "In-Reply-To: <parent@mail.test>",
    "References: <parent@mail.test> <ack@bountydesk.test>",
    "Subject: Re: We received your report",
  ].join("\r\n");
  assert.deepEqual(parseThreadReferences(headers), ["<parent@mail.test>", "<ack@bountydesk.test>"]);
});

test("a folded References header still yields every token", () => {
  const headers = ["References: <a@mail.test>", "\t<b@mail.test>", " <c@mail.test>"].join("\r\n");
  assert.deepEqual(parseThreadReferences(headers), ["<a@mail.test>", "<b@mail.test>", "<c@mail.test>"]);
});

test("a subject-only Re: with no threading headers yields no tokens", () => {
  // The anti-pattern this guards: matching on "Re: ..." would cross-link every reporter who shares
  // the acknowledgement subject. Without In-Reply-To or References there is nothing to link on.
  const headers = ["From: reporter@example.com", "Subject: Re: We received your report"].join("\r\n");
  assert.deepEqual(parseThreadReferences(headers), []);
});

test("a correctly signed webhook verifies, and tampering is rejected", () => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  const wh = new Webhook(SECRET);
  const body = JSON.stringify(received({ from: "a@b.com", message_id: "m6" }));
  const id = "msg_1";
  const timestamp = new Date();
  const signature = wh.sign(id, timestamp, body);
  const headers = {
    "svix-id": id,
    "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
    "svix-signature": signature,
  };

  const event = verifyResendWebhook(body, headers);
  assert.equal(event.type, "email.received");

  assert.throws(() => verifyResendWebhook(body + " ", headers), /.*/);
  assert.throws(() => verifyResendWebhook(body, { ...headers, "svix-signature": "v1,deadbeef" }), /.*/);
});
