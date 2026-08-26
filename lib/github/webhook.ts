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

/**
 * The largest webhook body we will buffer. GitHub does not deliver payloads above 25 MB and
 * an issue payload is orders of magnitude smaller, so anything near this cap is not a real
 * delivery.
 */
export const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

/**
 * Read the raw body, giving up once it exceeds `limit`.
 *
 * The signature cannot be checked until the bytes are in hand, so this runs before any
 * authentication and an unauthenticated caller decides how much it sends. Content-Length is
 * a hint from that same caller, so the cap is enforced against the bytes actually read as
 * well. Returns null when the body is too large.
 */
export async function readBoundedBody(
  request: Request,
  limit = MAX_WEBHOOK_BYTES,
): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;

  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}
