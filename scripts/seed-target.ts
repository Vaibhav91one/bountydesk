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
 * Q18 froze the target: Juice Shop v17.3.0 linux/amd64, at the digest below. Provisioning
 * rejects a snapshot whose resolved digest differs.
 */
const IMAGE_DIGEST =
  process.env.DAYTONA_TARGET_IMAGE_DIGEST ??
  "sha256:123acb31ed8bb05ebb06934a29be83d4e11a46cae937b9ed2bf2bda29d98130a";

async function main(): Promise<void> {
  const rawRepoId = process.argv[2];
  const repoId = Number(rawRepoId);
  if (!rawRepoId || !Number.isSafeInteger(repoId) || repoId <= 0) {
    throw new Error("usage: npm run seed:target -- <github-repository-id>");
  }

  const configured = await configureJuiceShopTarget({
    repoId,
    imageDigest: IMAGE_DIGEST,
    snapshotId: process.env.DAYTONA_TARGET_SNAPSHOT_ID ?? null,
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
