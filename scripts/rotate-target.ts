import { isValidImageDigest, isValidSnapshotId, rotateTarget } from "@/lib/targets/configure";
import {
  DEFAULT_TARGET_NAME,
  envNameForTarget,
  targetDefinitionFor,
} from "@/lib/targets/registry";

/**
 * Repoint a pinned target profile at a new, already-verified build.
 *
 *   npm run rotate:target -- <github-repository-id> [target-profile-name]
 *
 * The target name defaults to Juice Shop for compatibility. For every other target, the pin
 * comes from the target-specific BOUNTYDESK_TARGET_<TARGET>_* variables.
 */
async function main(): Promise<void> {
  const rawRepoId = process.argv[2];
  const targetName = process.argv[3] ?? DEFAULT_TARGET_NAME;
  const repoId = Number(rawRepoId);
  if (!rawRepoId || !Number.isSafeInteger(repoId) || repoId <= 0) {
    throw new Error("usage: npm run rotate:target -- <github-repository-id> [target-profile-name]");
  }

  const target = targetDefinitionFor(targetName);
  if (!target) throw new Error(`unknown target profile ${targetName}`);

  const imageDigestEnv = envNameForTarget(target, "IMAGE_DIGEST");
  const snapshotIdEnv = envNameForTarget(target, "SNAPSHOT_ID");
  const buildMarkerEnv = envNameForTarget(target, "BUILD_MARKER");
  const snapshotImageRefEnv = envNameForTarget(target, "SNAPSHOT_IMAGE_REF");
  const imageDigest =
    process.env[imageDigestEnv] ??
    (targetName === DEFAULT_TARGET_NAME ? process.env.DAYTONA_TARGET_IMAGE_DIGEST : undefined);
  const snapshotId =
    process.env[snapshotIdEnv] ??
    (targetName === DEFAULT_TARGET_NAME ? process.env.DAYTONA_TARGET_SNAPSHOT_ID : undefined);
  if (!imageDigest || !snapshotId) {
    throw new Error(`${imageDigestEnv} and ${snapshotIdEnv} must both be set`);
  }
  if (!isValidImageDigest(imageDigest) || !isValidSnapshotId(snapshotId)) {
    throw new Error(
      `${imageDigestEnv} or ${snapshotIdEnv} is still the env.example placeholder or malformed`,
    );
  }

  const rotated = await rotateTarget({
    repoId,
    targetName,
    imageDigest,
    snapshotId,
    ...(process.env[buildMarkerEnv] ? { buildMarker: process.env[buildMarkerEnv] } : {}),
    ...(process.env[snapshotImageRefEnv]
      ? { snapshotImageRefOverride: process.env[snapshotImageRefEnv] }
      : {}),
  });

  console.log(
    `rotated ${rotated.targetProfileName} (bound to ${rotated.repositoryFullName}) to digest ${imageDigest}, snapshot ${snapshotId}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
