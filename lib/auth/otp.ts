import crypto from "node:crypto";

import { requireSecret } from "@/lib/env";

/**
 * The one-time-code primitives, shared by the reviewer allowlist and by report-scoped contact
 * verification. They live here so the two callers cannot drift on the parts that matter for
 * security: the code space, the hash, the constant-time compare, the expiry, and the attempt cap.
 * A second copy of any of these is where one path quietly gets a weaker check than the other.
 */

export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length ? trimmed : null;
}

/**
 * HMAC-SHA256 under a dedicated key. A six-digit code has only a million values, so an unkeyed
 * hash lets anyone who can read the table recover a live code. requireSecret throws when the key
 * is unset, so issuing and verifying both fail closed instead of falling back to the unkeyed form.
 */
export function hashCode(code: string): string {
  return crypto.createHmac("sha256", requireSecret("OTP_HMAC_KEY")).update(code).digest("hex");
}

/** A six-digit code, kept as a fixed-width string so a leading zero stays part of it. */
export function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Compare a submitted code against a stored hash in constant time. */
export function codeMatches(storedHash: string, submitted: string): boolean {
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(hashCode(submitted), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
