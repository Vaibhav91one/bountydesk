import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Upload intake against a real Postgres: the held report, the contact proof that delivery depends on,
 * the daily limits, and the bounds on what an uploader may attach. Codes are captured by an injected
 * sender, so no mail goes out.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let intake: typeof import("./intake");
let recipient: typeof import("@/lib/email/recipient");

const CONFIG = { perSenderPerDay: 5, perDomainPerDay: 20, maxBytes: 512 * 1024, exemptDomains: ["gmail.com"] };
const codes = new Map<string, string>();
const sendCode = async (to: string, code: string) => void codes.set(to, code);

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("upload_intake");
  // Imported after the schema exists so @/lib/db points at it, never at the shared database.
  dbm = await import("@/lib/db");
  intake = await import("./intake");
  recipient = await import("@/lib/email/recipient");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function form(fields: Record<string, string | Blob>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const BASE = { title: "SQL injection in search", body: "Steps to reproduce...", contact: "Reporter@Outside.test" };
const DIGEST = `sha256:${"a".repeat(64)}`;

async function parse(fields: Record<string, string | Blob>) {
  return intake.parseUploadForm(form({ ...BASE, ...fields }), CONFIG);
}

async function admit(contact: string, ip: string | null = "198.51.100.1", fields: Record<string, string | Blob> = {}) {
  const parsed = await intake.parseUploadForm(form({ ...BASE, contact, ...fields }), CONFIG);
  assert.ok(parsed.ok);
  return intake.admitUpload(parsed.submission, ip, { sendCode, config: CONFIG });
}

async function reportRow(id: string) {
  const [row] = await dbm.db.select().from(dbm.report).where(dbm.eq(dbm.report.id, id));
  return row;
}

test("an upload becomes a report held at the gate on the upload channel, and its contact is mailed a code", async () => {
  const result = await admit("held@outside.test", "198.51.100.10", { imageRef: "ghcr.io/vendor/app:1.2", imageDigest: DIGEST });
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.codeSent, true);

  const row = await reportRow(result.reportId);
  assert.equal(row.channel, "upload");
  assert.equal(row.state, "NEEDS_DECISION");
  assert.match(row.sourceRef, /^upload:[0-9a-f-]{36}$/);
  assert.equal(row.reporterContact, "held@outside.test");
  assert.equal(row.verifiedSender, null);
  assert.equal(row.targetProfileId, null);
  assert.match(codes.get("held@outside.test") ?? "", /^\d{6}$/);

  const [upload] = await dbm.db.select().from(dbm.uploadIntake).where(dbm.eq(dbm.uploadIntake.reportId, result.reportId));
  assert.equal(upload.materialKind, "image");
  assert.equal(upload.imageDigest, DIGEST);
  assert.equal(upload.buildState, null);
});

test("a confirmed contact is a deliverable recipient and an unconfirmed one is not", async () => {
  const result = await admit("otp@outside.test", "198.51.100.11");
  assert.ok(result.accepted);
  if (!result.accepted) return;

  // The same check publish_verdict and the email arm run before a verdict goes out.
  assert.equal(await recipient.isVerifiedEmailRecipient(await reportRow(result.reportId)), false);

  const wrong = codes.get("otp@outside.test") === "000000" ? "111111" : "000000";
  assert.equal((await intake.confirmContactCode(result.reportId, wrong)).ok, false);
  assert.equal(await recipient.isVerifiedEmailRecipient(await reportRow(result.reportId)), false);

  assert.deepEqual(await intake.confirmContactCode(result.reportId, codes.get("otp@outside.test")!), { ok: true });
  const row = await reportRow(result.reportId);
  assert.equal(row.verifiedSender, "otp@outside.test");
  assert.equal(await recipient.isVerifiedEmailRecipient(row), true);

  // A confirmed contact gets no new code, because a new code would clear the proof.
  assert.equal((await intake.sendContactCode(result.reportId, sendCode)).ok, false);
  assert.equal((await reportRow(result.reportId)).verifiedSender, "otp@outside.test");
});

test("the code endpoints act only on upload reports", async () => {
  const [email] = await dbm.db
    .insert(dbm.report)
    .values({ channel: "email", sourceRef: "email:<x@y>", title: "t", body: "b", reporterContact: "someone@else.test" })
    .returning({ id: dbm.report.id });
  assert.deepEqual(await intake.sendContactCode(email.id, sendCode), { ok: false, reason: "no such upload" });
  assert.deepEqual(await intake.confirmContactCode(email.id, "123456"), { ok: false, reason: "no such upload" });
  assert.equal((await reportRow(email.id)).reporterContact, "someone@else.test");
});

test("a report gets a fixed number of codes", async () => {
  const result = await admit("resend@outside.test", "198.51.100.12");
  assert.ok(result.accepted);
  if (!result.accepted) return;
  for (let i = 1; i < intake.UPLOAD_LIMITS.maxCodeSends; i++) {
    assert.deepEqual(await intake.sendContactCode(result.reportId, sendCode), { ok: true });
  }
  assert.equal((await intake.sendContactCode(result.reportId, sendCode)).ok, false);
});

test("a code that fails to send is not counted, and the uploader can still confirm afterwards", async () => {
  const failing = async () => {
    throw new Error("resend 503");
  };
  const parsed = await intake.parseUploadForm(form({ ...BASE, contact: "outage@outside.test" }), CONFIG);
  assert.ok(parsed.ok);
  const result = await intake.admitUpload(parsed.submission, "198.51.100.13", { sendCode: failing, config: CONFIG });
  assert.ok(result.accepted);
  if (!result.accepted) return;
  assert.equal(result.codeSent, false);
  assert.equal(await intake.codesSent(result.reportId), 0);

  // More failures than the cap still spend nothing.
  for (let i = 0; i < intake.UPLOAD_LIMITS.maxCodeSends + 1; i++) {
    assert.equal((await intake.sendContactCode(result.reportId, failing)).ok, false);
  }
  assert.equal(await intake.codesSent(result.reportId), 0);

  assert.deepEqual(await intake.sendContactCode(result.reportId, sendCode), { ok: true });
  assert.equal(await intake.codesSent(result.reportId), 1);
  assert.deepEqual(await intake.confirmContactCode(result.reportId, codes.get("outage@outside.test")!), { ok: true });
  assert.equal(await recipient.isVerifiedEmailRecipient(await reportRow(result.reportId)), true);
});

test("concurrent resends cannot slip past the cap", async () => {
  const result = await admit("race@outside.test", "198.51.100.14");
  assert.ok(result.accepted);
  if (!result.accepted) return;
  let mailed = 1;
  const counting = async () => void (mailed += 1);
  const outcomes = await Promise.all(
    Array.from({ length: 6 }, () => intake.sendContactCode(result.reportId, counting)),
  );
  assert.equal(outcomes.filter((o) => o.ok).length, intake.UPLOAD_LIMITS.maxCodeSends - 1);
  assert.equal(mailed, intake.UPLOAD_LIMITS.maxCodeSends);
  assert.equal(await intake.codesSent(result.reportId), intake.UPLOAD_LIMITS.maxCodeSends);
});

test("uploads over the per-contact daily limit are refused", async () => {
  // Subaddresses of one mailbox count as one contact.
  for (let i = 0; i < CONFIG.perSenderPerDay; i++) {
    assert.equal((await admit(`flood+${i}@gmail.com`, `203.0.113.${i}`)).accepted, true);
  }
  const over = await admit("flood+x@gmail.com", "203.0.113.99");
  assert.equal(over.accepted, false);
  if (!over.accepted) assert.equal(over.status, 429);
});

test("uploads over the per-address daily limit are refused", async () => {
  for (let i = 0; i < intake.UPLOAD_LIMITS.perAddressPerDay; i++) {
    assert.equal((await admit(`person${i}@gmail.com`, "192.0.2.50")).accepted, true);
  }
  const over = await admit("another@gmail.com", "192.0.2.50");
  assert.deepEqual(over, { accepted: false, status: 429, reason: "this address is over its daily upload limit" });
});

test("the form refuses missing fields, wrong file types, oversize files and mixed material", async () => {
  assert.equal((await parse({ title: "" })).ok, false);
  assert.equal((await parse({ contact: "not-an-email" })).ok, false);
  assert.deepEqual(await parse({ archive: new Blob(["just text, not a tarball"]) }), {
    ok: false,
    reason: "the source archive must be a .tar or .tar.gz file",
  });
  assert.equal((await parse({ dockerfile: new Blob(["\0\0binary"]) })).ok, false);
  assert.equal((await parse({ dockerfile: new Blob(["RUN echo no base image"]) })).ok, false);
  assert.deepEqual(await parse({ dockerfile: new Blob([`FROM alpine\n#${"x".repeat(70 * 1024)}`]) }), {
    ok: false,
    reason: `the Dockerfile is over ${intake.UPLOAD_LIMITS.maxDockerfileBytes} bytes`,
  });
  assert.equal(
    (await parse({ dockerfile: new Blob(["FROM alpine\n"]), imageRef: "nginx:1", imageDigest: DIGEST })).ok,
    false,
  );
  assert.equal((await parse({ body: "x".repeat(CONFIG.maxBytes + 1) })).ok, false);
});

test("a prebuilt image from a registry outside the allowlist is refused", async () => {
  const refused = await parse({ imageRef: "evil.example.com/team/app:1", imageDigest: DIGEST });
  assert.deepEqual(refused, {
    ok: false,
    reason: "images from evil.example.com are not accepted; allowed registries are docker.io, ghcr.io",
  });
  assert.equal((await parse({ imageRef: "nginx:1.27", imageDigest: DIGEST })).ok, true);
  assert.equal((await parse({ imageRef: "ghcr.io/org/app:2", imageDigest: DIGEST })).ok, true);
  assert.equal((await parse({ imageRef: "ghcr.io/org/app@sha256:abc", imageDigest: DIGEST })).ok, false);
  assert.equal((await parse({ imageRef: "ghcr.io/org/app:2", imageDigest: "sha256:short" })).ok, false);
});

test("the client address comes from the edge, not from a value the requester chose", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  assert.equal(intake.clientAddress(h({ "x-real-ip": "203.0.113.5", "x-forwarded-for": "1.2.3.4" })), "203.0.113.5");
  // A spoofed first hop is ignored; the entry the nearest proxy appended counts.
  assert.equal(intake.clientAddress(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.6" })), "203.0.113.6");
  assert.equal(intake.clientAddress(h({})), null);
});

test("an uploaded Dockerfile is wrapped in a deterministic one-file tarball that tar can read", async () => {
  const content = Buffer.from("FROM alpine:3.20\nCMD [\"sleep\", \"1\"]\n");
  const first = intake.singleFileTar("Dockerfile", content);
  assert.deepEqual(first, intake.singleFileTar("Dockerfile", content));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-tar-"));
  try {
    const file = path.join(dir, "source.tar");
    fs.writeFileSync(file, first);
    assert.equal(execFileSync("tar", ["-tf", file]).toString().trim(), "Dockerfile");
    assert.equal(execFileSync("tar", ["-xOf", file, "Dockerfile"]).toString(), content.toString());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
