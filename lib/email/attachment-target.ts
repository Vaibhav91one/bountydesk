import { createHash } from "node:crypto";

import { db, uploadIntake, type Executor } from "@/lib/db";
import { recordEvent } from "@/lib/reports/lifecycle";
import {
  checkDecompressionBound,
  isTarball,
  isValidDockerfileText,
  singleFileTar,
  UPLOAD_LIMITS,
} from "@/lib/upload/intake";

import type { InboundAttachment } from "./resend";
import { readOutsideConfig, type OutsideConfig } from "./outside-config";
import { normalizeSender, senderDomain } from "./outside-intake";

/**
 * Ingest a target from an inbound email's attachments, reusing the public upload path.
 *
 * An emailed report can carry the same target material an uploader attaches on the submit page: a
 * source tarball or a Dockerfile. The bytes come from the receiving API (lib/email/resend.ts), and
 * the caller only reaches here for a verified sender (an outside sender that passed SPF and DKIM, or
 * an allowlisted reviewer), so this file never decides trust, only what a verified sender's
 * attachment is. The row it writes is the same upload_intake shape the submit page writes, so the
 * reviewer gate and the build loop treat an emailed target exactly like an uploaded one.
 */

/** The archive-bearing subset of upload material an email attachment can produce (never a prebuilt image). */
export type EmailTargetMaterial = { kind: "archive" | "dockerfile"; archive: Buffer };

/** Whether a filename names a Dockerfile: `Dockerfile`, `Dockerfile.prod`, or `service.dockerfile`. */
function looksLikeDockerfileName(filename: string): boolean {
  const base = (filename.toLowerCase().split("/").pop() ?? "").trim();
  return base === "dockerfile" || base.startsWith("dockerfile.") || base.endsWith(".dockerfile");
}

/**
 * The first attachment that is a valid source tarball or Dockerfile, or null. A tarball is detected
 * by its magic bytes, the same as the upload form, so the extension does not matter; a Dockerfile is
 * detected by name and then validated as text with a FROM. An attachment over its size cap, one that
 * fails the decompression-bound check (the same zip-bomb guard the public upload form applies; this
 * path feeds the same unbounded `tar -xf` in the build sandbox), or one that is neither, is skipped
 * and the scan continues, so an unrelated screenshot never blocks a real target and an oversize or
 * bomb-shaped attachment never becomes material.
 */
export async function selectTargetMaterial(
  attachments: InboundAttachment[],
  config: OutsideConfig,
): Promise<EmailTargetMaterial | null> {
  for (const attachment of attachments) {
    if (isTarball(attachment.content)) {
      if (attachment.content.length > config.maxBytes) continue;
      if (!(await checkDecompressionBound(attachment.content)).ok) continue;
      return { kind: "archive", archive: attachment.content };
    }
    if (looksLikeDockerfileName(attachment.filename)) {
      if (attachment.content.length > UPLOAD_LIMITS.maxDockerfileBytes) continue;
      if (!isValidDockerfileText(attachment.content.toString("utf8"))) continue;
      return { kind: "dockerfile", archive: singleFileTar("Dockerfile", attachment.content) };
    }
  }
  return null;
}

/**
 * Attach a verified email report's target material by writing its upload_intake row. Idempotent on
 * the report: a job retry that reruns parse finds the row already there and does nothing, because a
 * report has one target and the row's report_id is unique. Returns whether a row was newly written.
 */
export async function attachEmailTarget(opts: {
  reportId: string;
  fromEmail: string;
  attachments: InboundAttachment[];
  config?: OutsideConfig;
  exec?: Executor;
}): Promise<{ attached: boolean; kind?: string }> {
  const config = opts.config ?? (await readOutsideConfig());
  const material = await selectTargetMaterial(opts.attachments, config);
  if (!material) return { attached: false };

  const exec = opts.exec ?? db;
  const archive = material.archive;
  const inserted = await exec
    .insert(uploadIntake)
    .values({
      reportId: opts.reportId,
      senderKey: normalizeSender(opts.fromEmail),
      senderDomain: senderDomain(opts.fromEmail),
      clientIp: null,
      materialKind: material.kind,
      archive,
      sourceArchiveDigest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      materialBytes: archive.length,
    })
    .onConflictDoNothing({ target: uploadIntake.reportId })
    .returning({ id: uploadIntake.id });
  // A retry (or a report that already carried material) inserts nothing, so record the event only
  // once, when this call is the one that wrote the row.
  if (inserted.length === 0) return { attached: false, kind: material.kind };

  await recordEvent(
    opts.reportId,
    "intake.target_attached",
    { materialKind: material.kind, materialBytes: archive.length },
    { tx: opts.exec },
  );
  return { attached: true, kind: material.kind };
}
