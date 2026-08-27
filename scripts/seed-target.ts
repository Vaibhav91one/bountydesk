import { configureJuiceShopTarget } from "@/lib/targets/configure";

/**
 * Bind a connected repository to the pinned Juice Shop target.
 *
 * This is the operator action the Channels screen will do once the UI exists. Intake refuses
 * any repository with no target bound, so without this nothing gets past the gate, and doing
 * it by hand in SQL is worse than doing it in a script that at least says what it did.
 *
 *   npm run seed:target -- 123456789
 *
 * Q18 froze the target: Juice Shop v17.3.0 linux/amd64. DAYTONA_TARGET_IMAGE_DIGEST and
 * DAYTONA_TARGET_SNAPSHOT_ID must both be set by an operator who has actually built and
 * verified the connected fork; there is no bundled fallback, because a fallback digest here
 * would seed real installations against an artifact nobody chose.
 */
async function main(): Promise<void> {
  const rawRepoId = process.argv[2];
  const repoId = Number(rawRepoId);
  if (!rawRepoId || !Number.isSafeInteger(repoId) || repoId <= 0) {
    throw new Error("usage: npm run seed:target -- <github-repository-id>");
  }

  const imageDigest = process.env.DAYTONA_TARGET_IMAGE_DIGEST;
  const snapshotId = process.env.DAYTONA_TARGET_SNAPSHOT_ID;
  if (!imageDigest || !snapshotId) {
    throw new Error("DAYTONA_TARGET_IMAGE_DIGEST and DAYTONA_TARGET_SNAPSHOT_ID must both be set");
  }

  const configured = await configureJuiceShopTarget({ repoId, imageDigest, snapshotId });

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
