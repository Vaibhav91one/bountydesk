import { isValidImageDigest, isValidSnapshotId, rotateJuiceShopTarget } from "@/lib/targets/configure";

/**
 * Repoint the pinned Juice Shop target at a new, already-verified build.
 *
 *   npm run rotate:target -- <github-repository-id>
 *
 * DAYTONA_TARGET_IMAGE_DIGEST and DAYTONA_TARGET_SNAPSHOT_ID must already be updated to the new
 * build's real values before running this: unlike seed-target.ts, this refuses to create a
 * profile that doesn't exist yet, and unlike configureJuiceShopTarget, it never asks whether
 * the change is intended, it says so by being run.
 */
async function main(): Promise<void> {
  const rawRepoId = process.argv[2];
  const repoId = Number(rawRepoId);
  if (!rawRepoId || !Number.isSafeInteger(repoId) || repoId <= 0) {
    throw new Error("usage: npm run rotate:target -- <github-repository-id>");
  }

  const imageDigest = process.env.DAYTONA_TARGET_IMAGE_DIGEST;
  const snapshotId = process.env.DAYTONA_TARGET_SNAPSHOT_ID;
  if (!imageDigest || !snapshotId) {
    throw new Error("DAYTONA_TARGET_IMAGE_DIGEST and DAYTONA_TARGET_SNAPSHOT_ID must both be set");
  }
  if (!isValidImageDigest(imageDigest) || !isValidSnapshotId(snapshotId)) {
    throw new Error(
      "DAYTONA_TARGET_IMAGE_DIGEST or DAYTONA_TARGET_SNAPSHOT_ID is still the env.example placeholder or malformed",
    );
  }

  const rotated = await rotateJuiceShopTarget({ repoId, imageDigest, snapshotId });

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
