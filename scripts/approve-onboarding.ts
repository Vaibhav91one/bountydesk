import { client, db, targetOnboarding } from "@/lib/db";
import { eq } from "drizzle-orm";

import { approveOnboardingRequest } from "@/lib/build-onboarding/approve-request";

/**
 * Approve a proposed target manifest, as a reviewer, so the pipeline may write the TargetProfile.
 *
 *   npm run approve:onboarding -- <repoId> <reviewer-email> [reviewer-login]
 *
 * The reviewer email is checked against the same allow-list the UI uses, so this is a real human
 * gate, not a bypass: only a listed reviewer can move a row to APPROVED, and only from
 * AWAITING_APPROVAL. The React panel that will replace this runs the same approveOnboardingRequest.
 */
async function main(): Promise<void> {
  const rawRepoId = process.argv[2];
  const email = process.argv[3];
  const login = process.argv[4] ?? email;

  if (!rawRepoId || !email) {
    console.error("usage: approve-onboarding.ts <repoId> <reviewer-email> [reviewer-login]");
    process.exit(1);
  }

  const result = await approveOnboardingRequest({ login, email, avatarUrl: null }, rawRepoId);

  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }

  const [row] = await db
    .select({ state: targetOnboarding.state })
    .from(targetOnboarding)
    .where(eq(targetOnboarding.repoId, Number(rawRepoId)))
    .limit(1);
  console.log(`approved onboarding for repo ${rawRepoId}; state is now ${row?.state}`);
}

main()
  .then(async () => {
    await client.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await client.end({ timeout: 5 }).catch(() => undefined);
    process.exit(1);
  });
