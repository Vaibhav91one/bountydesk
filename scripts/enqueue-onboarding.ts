import { client } from "@/lib/db";
import { enqueue } from "@/lib/build-onboarding/queue";

/**
 * Enqueue a target for onboarding, for a source that did not arrive through the GitHub connect
 * webhook (a re-run after a failure was cleared, or a target being onboarded by hand).
 *
 *   npm run enqueue:onboarding -- <repoId> <owner/name>
 *
 * repoId is the numeric id configureTarget keys the eventual write on. The clone URL is derived
 * from owner/name here, not accepted as free text: the build driver clones a URL built from the
 * server-held repository name, so nothing a caller passes can redirect the clone. Idempotent on
 * repoId, and a FAILED row is requeued from the start.
 */
const REPO_FULL_NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

async function main(): Promise<void> {
  const rawRepoId = process.argv[2];
  const repoFullName = process.argv[3];

  const repoId = Number(rawRepoId);
  if (!Number.isSafeInteger(repoId) || repoId <= 0 || !repoFullName || !REPO_FULL_NAME_RE.test(repoFullName)) {
    console.error("usage: enqueue-onboarding.ts <repoId> <owner/name>");
    process.exit(1);
  }

  // Derived, not caller-provided: the same shape the GitHub trigger uses.
  const sourceRef = `https://github.com/${repoFullName}.git`;
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
