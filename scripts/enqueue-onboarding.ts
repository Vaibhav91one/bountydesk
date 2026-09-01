import { client } from "@/lib/db";
import { enqueue } from "@/lib/build-onboarding/queue";

/**
 * Enqueue a target for onboarding, for a source that did not arrive through the GitHub connect
 * webhook (an email or uploaded report's target, or a re-run after a failure was cleared).
 *
 *   npm run enqueue:onboarding -- <repoId> <owner/name> <sourceRef>
 *
 * repoId is the numeric id configureTarget keys the eventual write on; sourceRef is what the
 * build driver clones (a git URL). Idempotent on repoId: a second run for the same repo is a
 * no-op, so this is safe to re-run.
 */
async function main(): Promise<void> {
  const rawRepoId = process.argv[2];
  const repoFullName = process.argv[3];
  const sourceRef = process.argv[4];

  const repoId = Number(rawRepoId);
  if (!Number.isSafeInteger(repoId) || repoId <= 0 || !repoFullName || !sourceRef) {
    console.error("usage: enqueue-onboarding.ts <repoId> <owner/name> <sourceRef>");
    process.exit(1);
  }

  await enqueue({ repoId, repoFullName, sourceRef });
  console.log(`enqueued onboarding for ${repoFullName} (repo ${repoId})`);
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
