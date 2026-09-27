import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test, { after, before } from "node:test";

import type { InboundAttachment } from "./resend";

/**
 * The email-to-target path: which attachment becomes buildable material, and the upload_intake row
 * it writes. selectTargetMaterial is pure, so its cases run without a database; attachEmailTarget
 * writes a row, so it runs against a disposable schema with @/lib/db imported after the schema exists.
 */

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let mod: typeof import("./attachment-target");
let uploadIntakeMod: typeof import("@/lib/upload/intake");

const CONFIG = { perSenderPerDay: 5, perDomainPerDay: 20, maxBytes: 512 * 1024, exemptDomains: [] };

function attachment(filename: string, content: Buffer | string, contentType = ""): InboundAttachment {
  return { filename, contentType, content: typeof content === "string" ? Buffer.from(content) : content };
}

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("email_attachment_target");
  dbm = await import("@/lib/db");
  mod = await import("./attachment-target");
  uploadIntakeMod = await import("@/lib/upload/intake");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

test("a Dockerfile attachment is selected and wrapped in a one-file tarball", () => {
  const source = "FROM alpine:3.20\nCMD [\"true\"]\n";
  const material = mod.selectTargetMaterial([attachment("Dockerfile", source)], CONFIG);
  assert.equal(material?.kind, "dockerfile");
  assert.deepEqual(material?.archive, uploadIntakeMod.singleFileTar("Dockerfile", Buffer.from(source)));
});

test("a .tar.gz is selected as archive material by its magic bytes, whatever its name", () => {
  const gz = gzipSync(uploadIntakeMod.singleFileTar("Dockerfile", Buffer.from("FROM alpine\n")));
  const material = mod.selectTargetMaterial([attachment("source.bin", gz)], CONFIG);
  assert.equal(material?.kind, "archive");
  assert.deepEqual(material?.archive, gz);
});

test("an oversize attachment is ignored, not accepted", () => {
  const small = { ...CONFIG, maxBytes: 64 };
  const bigTar = gzipSync(uploadIntakeMod.singleFileTar("Dockerfile", Buffer.from("FROM alpine\n".repeat(50))));
  assert.ok(bigTar.length > small.maxBytes);
  assert.equal(mod.selectTargetMaterial([attachment("big.tar.gz", bigTar)], small), null);

  const bigDockerfile = attachment("Dockerfile", "FROM alpine\n" + "#".repeat(uploadIntakeMod.UPLOAD_LIMITS.maxDockerfileBytes));
  assert.equal(mod.selectTargetMaterial([bigDockerfile], CONFIG), null);
});

test("an unsupported or invalid attachment is ignored", () => {
  assert.equal(mod.selectTargetMaterial([], CONFIG), null);
  // A PNG-ish blob: not a tarball and not named like a Dockerfile.
  assert.equal(mod.selectTargetMaterial([attachment("shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]))], CONFIG), null);
  // Named like a Dockerfile but binary, so it fails the text/FROM check.
  assert.equal(mod.selectTargetMaterial([attachment("Dockerfile", Buffer.from([0, 1, 2, 3]))], CONFIG), null);
  // Named like a Dockerfile but no FROM instruction.
  assert.equal(mod.selectTargetMaterial([attachment("Dockerfile", "RUN echo hi\n")], CONFIG), null);
});

test("the first valid attachment wins and the rest are ignored", () => {
  const material = mod.selectTargetMaterial(
    [
      attachment("notes.txt", "just prose"),
      attachment("Dockerfile", "FROM node:20\n"),
      attachment("also.tar.gz", gzipSync(uploadIntakeMod.singleFileTar("Dockerfile", Buffer.from("FROM alpine\n")))),
    ],
    CONFIG,
  );
  assert.equal(material?.kind, "dockerfile");
});

async function emailReport(from: string): Promise<string> {
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({ channel: "email", sourceRef: `email:<${from}-${Math.random()}>`, title: "t", body: "b", reporterContact: from })
    .returning({ id: dbm.report.id });
  return row.id;
}

test("attachEmailTarget writes the upload_intake row and is idempotent per report", async () => {
  const reportId = await emailReport("finder@outside.test");
  const first = await mod.attachEmailTarget({
    reportId,
    fromEmail: "finder@outside.test",
    attachments: [attachment("Dockerfile", "FROM alpine\n")],
    config: CONFIG,
  });
  assert.deepEqual(first, { attached: true, kind: "dockerfile" });

  const [upload] = await dbm.db.select().from(dbm.uploadIntake).where(dbm.eq(dbm.uploadIntake.reportId, reportId));
  assert.equal(upload.materialKind, "dockerfile");
  assert.equal(upload.senderKey, "finder@outside.test");
  assert.equal(upload.senderDomain, "outside.test");
  assert.equal(upload.buildState, null);
  assert.match(upload.sourceArchiveDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.ok((upload.materialBytes ?? 0) > 0);

  // A retry of the parse step must not write a second row or a second event.
  const again = await mod.attachEmailTarget({
    reportId,
    fromEmail: "finder@outside.test",
    attachments: [attachment("Dockerfile", "FROM alpine\n")],
    config: CONFIG,
  });
  assert.equal(again.attached, false);
  const rows = await dbm.db.select().from(dbm.uploadIntake).where(dbm.eq(dbm.uploadIntake.reportId, reportId));
  assert.equal(rows.length, 1);
});

test("attachEmailTarget writes nothing when no attachment is a target", async () => {
  const reportId = await emailReport("noattach@outside.test");
  const result = await mod.attachEmailTarget({
    reportId,
    fromEmail: "noattach@outside.test",
    attachments: [attachment("photo.jpg", Buffer.from([0xff, 0xd8, 0xff]))],
    config: CONFIG,
  });
  assert.equal(result.attached, false);
  const rows = await dbm.db.select().from(dbm.uploadIntake).where(dbm.eq(dbm.uploadIntake.reportId, reportId));
  assert.equal(rows.length, 0);
});
