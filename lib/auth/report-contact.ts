import { db, eq, report } from "@/lib/db";

import {
  CODE_TTL_MS,
  codeMatches,
  EMAIL_SHAPE,
  generateCode,
  hashCode,
  MAX_CODE_ATTEMPTS,
  normalizeEmail,
} from "./otp";

/**
 * Verify the email a report should be delivered to, by one-time code, for a channel that has no
 * inbound SPF/DKIM to prove the address (upload).
 *
 * This is the report-scoped twin of the reviewer allowlist OTP, and deliberately not the same
 * table: an uploader proving they control an address must not become an operator. On success it
 * sets verified_sender to the proven contact, which is the exact value isVerifiedEmailRecipient
 * already checks against reporter_contact, so the delivery gate and the send path need no change.
 *
 * The code is returned rather than mailed here, the way startVerification is, so this stays a pure
 * database function and the Resend send and its rate limit belong to the caller.
 */

export type StartContactVerificationResult = { status: "code_sent"; code: string };

export async function startContactVerification(
  reportId: string,
  email: string,
): Promise<StartContactVerificationResult> {
  const normalized = normalizeEmail(email);
  if (!normalized || !EMAIL_SHAPE.test(normalized)) {
    throw new Error(`"${email}" is not a valid email address`);
  }

  const code = generateCode();
  const updated = await db
    .update(report)
    .set({
      reporterContact: normalized,
      // A fresh code resets any earlier proof: an address verified before and then changed cannot
      // deliver until the new one is proven, which is the same "proof binds one address, not the
      // report" rule isVerifiedEmailRecipient enforces.
      verifiedSender: null,
      contactCodeHash: hashCode(code),
      contactCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      contactCodeAttempts: 0,
      updatedAt: new Date(),
    })
    .where(eq(report.id, reportId))
    .returning({ id: report.id });

  if (updated.length === 0) throw new Error(`report ${reportId} not found`);
  return { status: "code_sent", code };
}

export type VerifyContactResult = { ok: true } | { ok: false; error: string };

export async function verifyContactCode(
  reportId: string,
  code: string,
): Promise<VerifyContactResult> {
  const submitted = code.trim();
  if (!/^\d{6}$/.test(submitted)) return { ok: false, error: "Enter the six-digit code." };

  // The read and the attempt increment are one transaction under a row lock, so two submissions
  // cannot both spend the same attempt and slip past the cap on a 6-digit code.
  return db.transaction(async (tx): Promise<VerifyContactResult> => {
    const [row] = await tx
      .select({
        reporterContact: report.reporterContact,
        verifiedSender: report.verifiedSender,
        contactCodeHash: report.contactCodeHash,
        contactCodeExpiresAt: report.contactCodeExpiresAt,
        contactCodeAttempts: report.contactCodeAttempts,
      })
      .from(report)
      .where(eq(report.id, reportId))
      .for("update")
      .limit(1);

    if (!row) return { ok: false, error: "No such report." };
    if (row.reporterContact && row.verifiedSender === row.reporterContact) return { ok: true };
    if (!row.contactCodeHash || !row.contactCodeExpiresAt || !row.reporterContact) {
      return { ok: false, error: "There is no pending code for this report. Send a new one." };
    }
    if (row.contactCodeExpiresAt.getTime() < Date.now()) {
      return { ok: false, error: "That code has expired. Send a new one." };
    }
    if (row.contactCodeAttempts >= MAX_CODE_ATTEMPTS) {
      return { ok: false, error: "Too many attempts. Send a new code." };
    }

    if (!codeMatches(row.contactCodeHash, submitted)) {
      await tx
        .update(report)
        .set({ contactCodeAttempts: row.contactCodeAttempts + 1, updatedAt: new Date() })
        .where(eq(report.id, reportId));
      return { ok: false, error: "That code is not correct." };
    }

    await tx
      .update(report)
      .set({
        verifiedSender: row.reporterContact,
        contactCodeHash: null,
        contactCodeExpiresAt: null,
        contactCodeAttempts: 0,
        updatedAt: new Date(),
      })
      .where(eq(report.id, reportId));
    return { ok: true };
  });
}
