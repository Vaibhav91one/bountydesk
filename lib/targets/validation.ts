const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Same character class createSandbox already accepts for a snapshot identifier. An env.example
 * placeholder like "<immutable-daytona-snapshot-id>" fails this on its own, since angle
 * brackets are not in it, so no separate placeholder blocklist is needed.
 */
const SNAPSHOT_ID_RE = /^[A-Za-z0-9._:@/-]{1,200}$/;

export function isValidImageDigest(value: string): boolean {
  return IMAGE_DIGEST_RE.test(value);
}

export function isValidSnapshotId(value: string): boolean {
  return SNAPSHOT_ID_RE.test(value);
}
