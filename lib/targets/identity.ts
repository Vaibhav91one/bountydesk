import { createHash } from "node:crypto";

export type TargetIdentityInput = {
  profileId: string;
  imageName: string | null;
  imageDigest: string;
  snapshotId: string | null;
  buildRecipeDigest: string | null;
  resolvedCommitSha: string | null;
  sourceArchiveDigest: string | null;
};

/** Hash server-owned target facts so a run cannot silently follow a rotated profile. */
export function targetIdentityHash(input: TargetIdentityInput): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}
