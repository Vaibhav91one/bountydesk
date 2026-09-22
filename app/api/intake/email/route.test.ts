import assert from "node:assert/strict";
import test, { before, beforeEach, mock } from "node:test";

import { Webhook } from "svix";

/**
 * The point of this suite is the authorization gate: a signed inbound message from a sender who is
 * not on the allowlist must never reach the queue. The signature check itself is covered in
 * lib/email/inbound.test.ts; here enqueue is mocked so the test observes whether the route would
 * have created a job, without a database.
 */
const SECRET = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;
process.env.RESEND_WEBHOOK_SECRET = SECRET;
process.env.REVIEWER_EMAILS = "allowed@example.com";

const enqueued: Array<{ channel: string; deliveryId: string }> = [];
mock.module("@/lib/jobs/queue", {
  namedExports: {
    enqueue: async (job: { channel: string; deliveryId: string }) => {
      enqueued.push(job);
    },
  },
});

// isReviewerEmail is async and hits the database for a non-owner; the allowlist's own behaviour is
// covered in lib/auth/reviewers.test.ts. Here it is stubbed so the route test proves only the
// wiring: signature, then gate, then enqueue, with no database.
mock.module("@/lib/auth/reviewers", {
  namedExports: {
    isReviewerEmail: async (email: string | null | undefined) =>
      email?.trim().toLowerCase() === "allowed@example.com",
  },
});

// The receipt path's own behaviour is covered in lib/email/receipts.test.ts against a real
// database. Here it is stubbed so this test proves only the dispatch: which handler a signed
// event reaches, and that an unsigned one reaches neither.
const receipted: string[] = [];
mock.module("@/lib/email/receipts", {
  namedExports: {
    isDeliveryEvent: (type: string) => type.startsWith("email.") && type !== "email.received",
    applyDeliveryReceipt: async (event: { type: string }) => {
      receipted.push(event.type);
      return { handled: true, reportId: "r", note: "ok" };
    },
  },
});

let POST: typeof import("./route").POST;

before(async () => {
  ({ POST } = await import("./route"));
});

beforeEach(() => {
  enqueued.length = 0;
  receipted.length = 0;
});

function signedRequest(from: string) {
  return signedBody({
    type: "email.received",
    data: { from, message_id: `<${Math.random()}@mail.gmail.com>`, email_id: "eid-1", subject: "XSS", text: "steps" },
  });
}

function signedBody(payload: unknown) {
  const body = JSON.stringify(payload);
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = new Date();
  const signature = new Webhook(SECRET).sign(id, timestamp, body);
  return new Request("https://app.example/api/intake/email", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
      "svix-signature": signature,
      "content-type": "application/json",
    },
    body,
  });
}

test("a signed message from a non-allowlisted sender is dropped, never enqueued", async () => {
  const res = await POST(signedRequest("stranger@example.com"));
  assert.equal(res.status, 202);
  assert.match(await res.text(), /not authorized/);
  assert.equal(enqueued.length, 0);
});

test("a signed message from an allowlisted sender is enqueued", async () => {
  const res = await POST(signedRequest("Allowed@Example.com"));
  assert.equal(res.status, 202);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].channel, "email");
});

test("an unsigned message is rejected before the allowlist is consulted", async () => {
  const res = await POST(
    new Request("https://app.example/api/intake/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "email.received", data: { from: "allowed@example.com", message_id: "m" } }),
    }),
  );
  assert.equal(res.status, 401);
  assert.equal(enqueued.length, 0);
});

test("a signed delivery receipt goes to the receipt handler, never to intake", async () => {
  const res = await POST(
    signedBody({ type: "email.delivered", data: { email_id: "re_1", to: ["someone@example.com"] } }),
  );
  assert.equal(res.status, 202);
  assert.deepEqual(receipted, ["email.delivered"]);
  // A receipt is mail we sent ourselves, so it must not be run through the sender allowlist or
  // turned into a report.
  assert.equal(enqueued.length, 0);
});

test("an unsigned delivery receipt is rejected before anything is applied", async () => {
  const res = await POST(
    new Request("https://app.example/api/intake/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "email.delivered", data: { email_id: "re_forged" } }),
    }),
  );
  assert.equal(res.status, 401);
  assert.equal(receipted.length, 0);
});
