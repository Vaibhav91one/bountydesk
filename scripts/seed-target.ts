import { configureTarget, isValidImageDigest, isValidSnapshotId } from "@/lib/targets/configure";
import {
  DEFAULT_TARGET_NAME,
  envNameForTarget,
  targetDefinitionFor,
} from "@/lib/targets/registry";

/**
 * Bind a connected repository to a pinned target profile.
 *
 * This is the operator action the Channels screen will do once the UI exists. Intake refuses
 * any repository with no target bound, so without this nothing gets past the gate, and doing
 * it by hand in SQL is worse than doing it in a script that at least says what it did.
 *
 *   npm run seed:target -- 123456789 [target-profile-name]
 *
 * The target name defaults to Juice Shop for compatibility with the first demo path. Other
 * targets read BOUNTYDESK_TARGET_<TARGET>_IMAGE_DIGEST and
 * BOUNTYDESK_TARGET_<TARGET>_SNAPSHOT_ID from the registry definition.
 */
async function main(): Promise<void> {
  const rawRepoId = process.argv[2];
  const targetName = process.argv[3] ?? DEFAULT_TARGET_NAME;
  const repoId = Number(rawRepoId);
  if (!rawRepoId || !Number.isSafeInteger(repoId) || repoId <= 0) {
    throw new Error("usage: npm run seed:target -- <github-repository-id> [target-profile-name]");
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

  const configured = await configureTarget({
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
    `bound ${configured.repositoryFullName} (${repoId}) to ${configured.targetProfileName}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
