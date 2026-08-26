import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify GitHub's `X-Hub-Signature-256` over the raw request bytes.
 *
 * The HMAC covers the bytes GitHub sent, so this takes a Buffer rather than a parsed body:
 * re-serialising JSON reorders keys and rewrites whitespace, and the digest would never
 * match. Callers must verify before parsing, which also keeps unsigned input away from
 * JSON.parse.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | null,
  secret: string,
): boolean {
  if (!header) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const received = Buffer.from(header);
  const wanted = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, and the length of a hex digest is not a
  // secret, so comparing it up front is safe.
  if (received.length !== wanted.length) return false;
  return timingSafeEqual(received, wanted);
}
