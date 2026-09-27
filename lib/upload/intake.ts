import { createHash, randomUUID } from "node:crypto";

import { EMAIL_SHAPE, normalizeEmail } from "@/lib/auth/otp";
import { startContactVerification, verifyContactCode } from "@/lib/auth/report-contact";
import { imageRegistryRefusal, isSafeImageRef } from "@/lib/build-onboarding/image-registries";
import { isSha256Digest } from "@/lib/build-onboarding/source-identity";
import { and, db, eq, inArray, report, sessionEvent, sql, uploadIntake, type Executor } from "@/lib/db";
import { readOutsideConfig, type OutsideConfig } from "@/lib/email/outside-config";
import { normalizeSender, overLimit, senderDomain } from "@/lib/email/outside-intake";
import { sendVerificationEmail } from "@/lib/email/resend";
import { safeErrorText } from "@/lib/errors/safe-error";
import { ensureReport, recordEvent, recordEventLocked } from "@/lib/reports/lifecycle";

/**
 * Intake for a report uploaded through the public submit page.
 *
 * The endpoint is open to anyone, so everything here is untrusted input with fixed bounds: the
 * request size, the field sizes, the file types, and the same per-sender and per-domain daily caps an
 * outside email sender gets, plus a per-address cap because an upload has no mail server in front of
 * it. An accepted upload becomes a report held at NEEDS_DECISION, the gate outside email and advisory
 * reports wait at, so nothing is built, provisioned or analysed until a reviewer releases it. The
 * contact address is unproven until its owner enters the one-time code, and delivery refuses it until
 * then (isVerifiedEmailRecipient).
 */

export const UPLOAD_LIMITS = {
  /** The whole multipart request. Vercel refuses a function body over 4.5 MB before it arrives. */
  maxRequestBytes: 4 * 1024 * 1024,
  maxTitleChars: 200,
  maxDockerfileBytes: 64 * 1024,
  /** Uploads from one client address per day, on top of the per-sender and per-domain caps. */
  perAddressPerDay: 10,
  /** Codes one report may have mailed to its contact, the first one included. */
  maxCodeSends: 3,
} as const;

export type UploadMaterial =
  | { kind: "archive"; archive: Buffer }
  | { kind: "dockerfile"; archive: Buffer }
  | { kind: "image"; imageRef: string; imageDigest: string };

export type UploadSubmission = {
  title: string;
  body: string;
  contact: string;
  material: UploadMaterial | null;
};

export type ParseResult = { ok: true; submission: UploadSubmission } | { ok: false; reason: string };

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** A browser posts an empty File for an untouched file input, so size 0 counts as absent. */
function file(form: FormData, key: string): File | null {
  const value = form.get(key);
  return value instanceof File && value.size > 0 ? value : null;
}

function isTarball(bytes: Buffer): boolean {
  const gzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const ustar = bytes.length >= 262 && bytes.subarray(257, 262).toString("latin1") === "ustar";
  return gzip || ustar;
}

/**
 * A one-file ustar archive holding `content` as `name`, so an uploaded Dockerfile rides the archive
 * build path with its own digest as the identity anchor. mtime, uid and gid are fixed at zero, so the
 * same Dockerfile always produces the same bytes and the same digest.
 */
export function singleFileTar(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write("00000000000\0", 136, "latin1");
  header.write("        ", 148, "latin1");
  header.write("0", 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding, Buffer.alloc(1024)]);
}

/**
 * Read and bound the submit form. The caller has already capped the raw request size; this checks
 * each field and decides what target material, if any, came with it. At most one kind is accepted,
 * because a build has one source.
 */
export async function parseUploadForm(form: FormData, config: OutsideConfig): Promise<ParseResult> {
  const title = text(form, "title");
  const body = text(form, "body");
  const contact = normalizeEmail(text(form, "contact")) ?? "";

  if (!title) return { ok: false, reason: "a title is required" };
  if (title.length > UPLOAD_LIMITS.maxTitleChars) {
    return { ok: false, reason: `the title is over ${UPLOAD_LIMITS.maxTitleChars} characters` };
  }
  if (!body) return { ok: false, reason: "a report body is required" };
  if (Buffer.byteLength(body, "utf8") > config.maxBytes) {
    return { ok: false, reason: `the report body is over ${config.maxBytes} bytes` };
  }
  if (!EMAIL_SHAPE.test(contact) || contact.length > 254) {
    return { ok: false, reason: "a valid contact email is required" };
  }

  const archive = file(form, "archive");
  const dockerfile = file(form, "dockerfile");
  const imageRef = text(form, "imageRef");
  const imageDigest = text(form, "imageDigest").toLowerCase();
  const kinds = [archive, dockerfile, imageRef || imageDigest ? "image" : null].filter(Boolean);
  if (kinds.length > 1) {
    return { ok: false, reason: "attach one kind of target material: a tarball, a Dockerfile, or an image" };
  }

  let material: UploadMaterial | null = null;
  if (archive) {
    const bytes = Buffer.from(await archive.arrayBuffer());
    if (!isTarball(bytes)) return { ok: false, reason: "the source archive must be a .tar or .tar.gz file" };
    material = { kind: "archive", archive: bytes };
  } else if (dockerfile) {
    if (dockerfile.size > UPLOAD_LIMITS.maxDockerfileBytes) {
      return { ok: false, reason: `the Dockerfile is over ${UPLOAD_LIMITS.maxDockerfileBytes} bytes` };
    }
    const bytes = Buffer.from(await dockerfile.arrayBuffer());
    const content = bytes.toString("utf8");
    // A NUL or a replacement character means binary or not UTF-8, which no Dockerfile is.
    if (content.includes("\0") || content.includes("�") || !/^\s*FROM\s+\S/im.test(content)) {
      return { ok: false, reason: "the Dockerfile must be a text file with a FROM instruction" };
    }
    material = { kind: "dockerfile", archive: singleFileTar("Dockerfile", bytes) };
  } else if (imageRef || imageDigest) {
    if (!imageRef || !isSafeImageRef(imageRef) || imageRef.includes("@")) {
      return { ok: false, reason: "the image reference must be a plain name and tag, such as ghcr.io/org/app:1.2" };
    }
    if (!isSha256Digest(imageDigest)) {
      return { ok: false, reason: "the image digest must be sha256: followed by 64 hex characters" };
    }
    const refusal = imageRegistryRefusal(imageRef);
    if (refusal) return { ok: false, reason: refusal };
    material = { kind: "image", imageRef, imageDigest };
  }

  return { ok: true, submission: { title, body, contact, material } };
}

/** Uploads in the last day from this sender, its domain and its client address. */
async function recentCounts(
  senderKey: string,
  domain: string,
  clientIp: string | null,
  tx: Executor,
): Promise<{ sender: number; domain: number; address: number }> {
  const rows = await tx.execute<{ sender: number; domain: number; address: number }>(sql`
    select count(*) filter (where ${uploadIntake.senderKey} = ${senderKey})::int as sender,
           count(*) filter (where ${uploadIntake.senderDomain} = ${domain})::int as domain,
           count(*) filter (where ${uploadIntake.clientIp} = ${clientIp})::int as address
      from ${uploadIntake}
     where ${uploadIntake.createdAt} > now() - interval '1 day'
  `);
  const row = rows[0];
  return { sender: row?.sender ?? 0, domain: row?.domain ?? 0, address: row?.address ?? 0 };
}

export type UploadAdmission =
  | { accepted: true; reportId: string; codeSent: boolean }
  | { accepted: false; status: 429; reason: string };

export type SendCode = (to: string, code: string) => Promise<void>;

const defaultSendCode: SendCode = (to, code) => sendVerificationEmail(to, code, "report-contact");

/**
 * Create the held report and mail the contact its first code.
 *
 * The recount and the inserts share one transaction under a single advisory lock, so two uploads
 * arriving together cannot both read "one under the limit". The code is mailed after the commit, so
 * the lock is never held across the network call; a failed send leaves the report in place and the
 * uploader can ask for another code.
 *
 * ponytail: one global lock for all uploads, fine at this volume; key it per domain if uploads
 * ever contend.
 */
export async function admitUpload(
  submission: UploadSubmission,
  clientIp: string | null,
  deps: { sendCode?: SendCode; config?: OutsideConfig } = {},
): Promise<UploadAdmission> {
  const config = deps.config ?? (await readOutsideConfig());
  const senderKey = normalizeSender(submission.contact);
  const domain = senderDomain(submission.contact);
  const material = submission.material;
  const archive = material && material.kind !== "image" ? material.archive : null;

  const admitted = await db.transaction(async (tx): Promise<{ reason: string } | { reportId: string }> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('upload-intake'))`);
    const counts = await recentCounts(senderKey, domain, clientIp, tx);
    const limited = overLimit(counts, submission.contact, config);
    if (limited) return { reason: limited.replace("sender", "contact") };
    if (clientIp && counts.address >= UPLOAD_LIMITS.perAddressPerDay) {
      return { reason: "this address is over its daily upload limit" };
    }

    const sourceRef = `upload:${randomUUID()}`;
    const reportId = await ensureReport(
      {
        channel: "upload",
        sourceRef,
        title: submission.title,
        body: submission.body,
        reporterHandle: null,
        reporterContact: submission.contact,
        state: "NEEDS_DECISION",
        connectedRepositoryId: null,
        targetProfileId: null,
      },
      tx,
    );
    await tx.insert(uploadIntake).values({
      reportId,
      senderKey,
      senderDomain: domain,
      clientIp,
      materialKind: material?.kind ?? null,
      archive,
      sourceArchiveDigest: archive ? `sha256:${createHash("sha256").update(archive).digest("hex")}` : null,
      imageRef: material?.kind === "image" ? material.imageRef : null,
      imageDigest: material?.kind === "image" ? material.imageDigest : null,
      materialBytes: archive?.length ?? null,
    });
    await recordEvent(reportId, "intake.accepted", { sourceRef, material: material?.kind ?? null }, { tx });
    return { reportId };
  });

  if ("reason" in admitted) return { accepted: false, status: 429, reason: admitted.reason };
  const codeSent = await sendContactCode(admitted.reportId, deps.sendCode ?? defaultSendCode);
  return { accepted: true, reportId: admitted.reportId, codeSent: codeSent.ok };
}

export type CodeResult = { ok: true } | { ok: false; reason: string };

/** An upload report that exists, with its contact and whether that contact is already proven. */
async function uploadContact(reportId: string) {
  const [row] = await db
    .select({ channel: report.channel, contact: report.reporterContact, verified: report.verifiedSender })
    .from(report)
    .where(eq(report.id, reportId))
    .limit(1);
  return row?.channel === "upload" && row.contact ? row : null;
}

/**
 * Mail the report's own contact a fresh code, at most maxCodeSends times per report. Only the address
 * given at upload can receive one: the contact is never taken from this request, so knowing a report
 * id does not let anyone point its delivery somewhere else. A contact that is already proven gets no
 * new code, because a new code clears the proof.
 */
export async function sendContactCode(reportId: string, sendCode: SendCode = defaultSendCode): Promise<CodeResult> {
  const row = await uploadContact(reportId);
  if (!row?.contact) return { ok: false, reason: "no such upload" };
  if (row.verified && row.verified === row.contact) return { ok: false, reason: "this contact is already confirmed" };

  // A slot is reserved under the report's row lock before anything is mailed, so two requests racing
  // cannot both read "under the cap". The cap bounds mail that went out, so a send that fails gives
  // its slot back. session_event is append-only, so the refund is a second event, not a delete.
  const reserved = await db.transaction(async (tx) => {
    await tx.select({ id: report.id }).from(report).where(eq(report.id, reportId)).for("update");
    if ((await codesSent(reportId, tx)) >= UPLOAD_LIMITS.maxCodeSends) return false;
    await recordEvent(reportId, CODE_SENT, {}, { tx });
    return true;
  });
  if (!reserved) return { ok: false, reason: "no more codes can be sent for this report" };

  try {
    const { code } = await startContactVerification(reportId, row.contact);
    await sendCode(row.contact, code);
  } catch (error) {
    console.error(`upload intake: code for ${reportId} did not send: ${safeErrorText(error)}`);
    // Under the same row lock, so the refund cannot race a concurrent reservation's event seq.
    await recordEventLocked(reportId, CODE_SEND_FAILED, {});
    return { ok: false, reason: "the code could not be sent; try again shortly" };
  }
  return { ok: true };
}

export const CODE_SENT = "upload.contact_code_sent";
export const CODE_SEND_FAILED = "upload.contact_code_send_failed";

/** Codes that actually went out: reservations less the ones refunded because their send failed. */
export async function codesSent(reportId: string, tx: Executor = db): Promise<number> {
  const [row] = await tx
    .select({
      sent: sql<number>`(count(*) filter (where ${sessionEvent.type} = ${CODE_SENT})
        - count(*) filter (where ${sessionEvent.type} = ${CODE_SEND_FAILED}))::int`,
    })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.reportId, reportId), inArray(sessionEvent.type, [CODE_SENT, CODE_SEND_FAILED])));
  return row?.sent ?? 0;
}

/** Check a code for an upload report's contact. Any other channel's report is refused. */
export async function confirmContactCode(reportId: string, code: string): Promise<CodeResult> {
  if (!(await uploadContact(reportId))) return { ok: false, reason: "no such upload" };
  const result = await verifyContactCode(reportId, code);
  if (!result.ok) return { ok: false, reason: result.error };
  // Under the report lock: a reviewer can be acting on the same report at the gate.
  await recordEventLocked(reportId, "upload.contact_verified", { method: "otp" }, "upload.contact_verified");
  return { ok: true };
}

/**
 * The client address the platform's edge saw. Vercel sets x-real-ip itself, so a requester cannot
 * choose it. Without it, the last x-forwarded-for entry is the one the nearest proxy appended; the
 * first is whatever the requester sent, which would let one machine mint a fresh per-address bucket
 * per request.
 */
export function clientAddress(headers: Headers): string | null {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return forwarded || null;
}
