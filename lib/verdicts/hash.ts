import { createHash } from "node:crypto";

/**
 * The hash a human's approval binds to. publish_verdict refuses any payload whose hash
 * differs from the one that was actually approved, so this has to be a plain, reproducible
 * digest of the exact bytes, not of some derived or re-serialized form of them.
 */
export function computeContentHash(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}
