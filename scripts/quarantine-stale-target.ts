import { quarantineStaleTargetProfile } from "@/lib/targets/quarantine";

/**
 * One-time repair: the "juice-shop-v17.3.0" profile in the real database was seeded before
 * DAYTONA_TARGET_IMAGE_DIGEST and DAYTONA_TARGET_SNAPSHOT_ID failed closed on a missing value,
 * so it carries upstream's digest (not the connected fork's) and the literal env.example
 * snapshot-id placeholder rather than a real one.
 *
 *   npm run quarantine:stale-target
 *
 * quarantineStaleTargetProfile refuses unless the stored values are exactly these, so running
 * this against a database where the profile has already been fixed, or was never wrong, is a
 * safe no-op error rather than a silent action on the wrong row.
 */
const PROFILE_NAME = "juice-shop-v17.3.0";
const STALE_IMAGE_DIGEST =
  "sha256:123acb31ed8bb05ebb06934a29be83d4e11a46cae937b9ed2bf2bda29d98130a";
const STALE_SNAPSHOT_ID = "<immutable-daytona-snapshot-id>";

async function main(): Promise<void> {
  const result = await quarantineStaleTargetProfile({
    profileName: PROFILE_NAME,
    expectedImageDigest: STALE_IMAGE_DIGEST,
    expectedSnapshotId: STALE_SNAPSHOT_ID,
    reason: "predates DAYTONA_TARGET_IMAGE_DIGEST/DAYTONA_TARGET_SNAPSHOT_ID failing closed on a missing value",
  });

  console.log(`quarantined target profile ${result.quarantinedProfileId}`);
  console.log(`reports moved to ANALYSIS_ONLY: ${result.clearedReportIds.join(", ") || "(none)"}`);
  console.log(`repositories unbound: ${result.clearedRepositoryIds.join(", ") || "(none)"}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
