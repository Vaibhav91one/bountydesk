import { connectedRepository, db, eq, targetProfile } from "@/lib/db";

/**
 * Bind a connected repository to the pinned Juice Shop target.
 *
 * This is the operator action the Channels screen will do once the UI exists. Intake refuses
 * any repository with no target bound, so without this nothing gets past the gate, and doing
 * it by hand in SQL is worse than doing it in a script that at least says what it did.
 *
 *   npm run seed:target -- acme/security-reports
 *
 * Q18 froze the target: Juice Shop v17.3.0 linux/amd64, at the digest below. Provisioning
 * rejects a snapshot whose resolved digest differs.
 */
const IMAGE_DIGEST =
  process.env.DAYTONA_TARGET_IMAGE_DIGEST ??
  "sha256:123acb31ed8bb05ebb06934a29be83d4e11a46cae937b9ed2bf2bda29d98130a";

const PROFILE_NAME = "juice-shop-v17.3.0";

async function main(): Promise<void> {
  const fullName = process.argv[2];
  if (!fullName) {
    throw new Error("usage: npm run seed:target -- <owner>/<repo>");
  }

  const [profile] = await db
    .insert(targetProfile)
    .values({
      name: PROFILE_NAME,
      imageDigest: IMAGE_DIGEST,
      snapshotId: process.env.DAYTONA_TARGET_SNAPSHOT_ID ?? null,
      config: {
        // The one legal target for the MVP. The sandbox reads this, never an agent string.
        baseUrl: "http://localhost:3000",
        searchPath: "/rest/products/search",
        canaryRegistrationPath: "/api/Users/",
      },
      scopeRules: [{ allow: "localhost" }],
    })
    .onConflictDoNothing()
    .returning({ id: targetProfile.id, name: targetProfile.name });

  const target =
    profile ??
    (
      await db
        .select({ id: targetProfile.id, name: targetProfile.name })
        .from(targetProfile)
        .where(eq(targetProfile.name, PROFILE_NAME))
        .limit(1)
    )[0];

  if (!target) throw new Error(`could not create or find the ${PROFILE_NAME} target profile`);

  const bound = await db
    .update(connectedRepository)
    .set({ targetProfileId: target.id, updatedAt: new Date() })
    .where(eq(connectedRepository.fullName, fullName))
    .returning({ id: connectedRepository.id, active: connectedRepository.active });

  if (bound.length === 0) {
    throw new Error(
      `${fullName} is not a connected repository. Install the GitHub App on it first, then run this again.`,
    );
  }

  console.log(`bound ${fullName} to ${target.name}`);
  if (!bound[0].active) {
    console.log("note: the installation grant is currently withdrawn, so intake stays closed");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
