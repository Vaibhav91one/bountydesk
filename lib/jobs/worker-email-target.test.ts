import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The email worker path for attached target material, end to end against a real Postgres.
 *
 * parseEmail pulls the body (and now the attachments) from the receiving API, so the Resend read is
 * faked to hand back exactly the attachments each case wants. What is asserted is the security gate:
 * a verified sender's attachment becomes an upload_intake row and the report still waits at the gate,
 * while an unverified sender's attachment writes nothing. The reviewer can then release the emailed
 * target the same way an uploaded one is released.
 */

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let queue: typeof import("./queue");
let worker: typeof import("./worker");
let gate: typeof import("@/lib/upload/gate");

const realFetch = globalThis.fetch;

/** resendEmailId -> the attachments the receiving API returns for it. */
const attachmentsById = new Map<string, { filename: string; content_type: string; content: string }[]>();

function stubReceiving() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const id = url.split("/emails/receiving/")[1] ?? "";
    const attachments = attachmentsById.get(id) ?? [];
    return new Response(JSON.stringify({ text: "steps to reproduce", attachments }), { status: 200 });
  }) as typeof fetch;
}

const noopAnalysis: import("./worker").AnalysisDriver = { ensureSession: async () => {}, run: async () => {} };
const noopHold = async () => {};

before(async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.REVIEWER_EMAILS = "owner@bountydesk.test";
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("worker_email_target");
  dbm = await import("@/lib/db");
  queue = await import("./queue");
  worker = await import("./worker");
  gate = await import("@/lib/upload/gate");
  stubReceiving();
});

after(async () => {
  globalThis.fetch = realFetch;
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;
function outsideEmail(from: string, attachments: { filename: string; content_type: string; content: string }[]) {
  seq += 1;
  const resendEmailId = `eid-${seq}`;
  attachmentsById.set(resendEmailId, attachments);
  const email = {
    messageId: `<msg-${seq}@mail.test>`,
    resendEmailId,
    fromEmail: from,
    fromName: null,
    subject: "XSS in search",
    text: "",
  };
  return { deliveryId: email.messageId, payload: { ...email, intake: "outside" as const, verifiedSender: from, senderKey: from } };
}

async function run() {
  return worker.runOnce("email-target-worker", { analysis: noopAnalysis, hold: noopHold, leaseSeconds: 60 });
}

async function reportFor(deliveryId: string) {
  const [job] = await dbm.db.select().from(dbm.inboundJob).where(dbm.eq(dbm.inboundJob.deliveryId, deliveryId)).limit(1);
  const [row] = await dbm.db.select().from(dbm.report).where(dbm.eq(dbm.report.id, job.reportId as string)).limit(1);
  return row;
}

async function uploadFor(reportId: string) {
  const [row] = await dbm.db.select().from(dbm.uploadIntake).where(dbm.eq(dbm.uploadIntake.reportId, reportId)).limit(1);
  return row;
}

const DOCKERFILE = { filename: "Dockerfile", content_type: "text/plain", content: Buffer.from("FROM alpine\n").toString("base64") };

test("a verified sender's Dockerfile attachment becomes target material, and the report waits at the gate", async () => {
  const { deliveryId, payload } = outsideEmail("finder@outside.test", [DOCKERFILE]);
  await queue.enqueue({ channel: "email", deliveryId, payload });
  await run();

  const report = await reportFor(deliveryId);
  assert.equal(report.state, "NEEDS_DECISION");
  const upload = await uploadFor(report.id);
  assert.equal(upload.materialKind, "dockerfile");
  assert.equal(upload.buildState, null);
  assert.match(upload.sourceArchiveDigest ?? "", /^sha256:[0-9a-f]{64}$/);

  // The reviewer releases the emailed target exactly as an uploaded one, and the build is queued.
  const approved = await gate.approveUploadTarget(report.id, "owner@bountydesk.test", { port: 3000, readinessPath: "/" });
  assert.deepEqual(approved, { ok: true });
  const afterApprove = await uploadFor(report.id);
  assert.equal(afterApprove.buildState, "PENDING");
  assert.equal((await reportFor(deliveryId)).state, "TRIAGING");
});

test("a verified sender's .tar.gz attachment becomes archive material", async () => {
  const { gzipSync } = await import("node:zlib");
  const { singleFileTar } = await import("@/lib/upload/intake");
  const gz = gzipSync(singleFileTar("Dockerfile", Buffer.from("FROM node:20\n"))).toString("base64");
  const { deliveryId, payload } = outsideEmail("tarball@outside.test", [
    { filename: "source.tar.gz", content_type: "application/gzip", content: gz },
  ]);
  await queue.enqueue({ channel: "email", deliveryId, payload });
  await run();

  const report = await reportFor(deliveryId);
  const upload = await uploadFor(report.id);
  assert.equal(upload.materialKind, "archive");
});

test("a text-only email attaches nothing and is unchanged", async () => {
  const { deliveryId, payload } = outsideEmail("plain@outside.test", []);
  await queue.enqueue({ channel: "email", deliveryId, payload });
  await run();

  const report = await reportFor(deliveryId);
  assert.equal(report.state, "NEEDS_DECISION");
  assert.equal(await uploadFor(report.id), undefined);
});

test("an unverified sender's attachment attaches nothing", async () => {
  seq += 1;
  const resendEmailId = `eid-${seq}`;
  attachmentsById.set(resendEmailId, [DOCKERFILE]);
  // A bare inbound email (no outside marker) from an address that is not on the reviewer allowlist:
  // the route would have dropped it before enqueue, and the worker's gate refuses it too.
  const deliveryId = `<unverified-${seq}@mail.test>`;
  await queue.enqueue({
    channel: "email",
    deliveryId,
    payload: {
      messageId: deliveryId,
      resendEmailId,
      fromEmail: "stranger@evil.test",
      fromName: null,
      subject: "hi",
      text: "",
    },
  });
  await run();

  const report = await reportFor(deliveryId);
  assert.equal(await uploadFor(report.id), undefined);
});
