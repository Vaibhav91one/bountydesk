import { isReviewerEmail } from "@/lib/auth/reviewers";
import type { Session } from "@/lib/auth/session";
import { enqueue } from "@/lib/build-onboarding/queue";
import { and, connectedRepository, db, eq, githubInstallation, isNull } from "@/lib/db";
import { privateRepoPolicyRefused } from "@/lib/github/repo-access";

export type BatchItem = { repoId: unknown; ok: boolean; error?: string };
export type BatchResult = { ok: false; error: string } | { ok: true; results: BatchItem[] };

const MAX_BATCH = 50;

/**
 * Queue several connected repositories for onboarding in one action. Each repository goes through
 * the same idempotent enqueue a single onboarding uses, so a repo already in flight or configured is
 * left as it is. Nothing here approves anything: every row starts at PENDING_PLAN, and the worker
 * stops it at AWAITING_APPROVAL for its own approveOnboardingRequest.
 *
 * A bad id is skipped and reported rather than failing the batch. Names and clone URLs come from
 * connected_repository, never from the client, and the grant is read per repository at enqueue time.
 */
export async function batchOnboardRequest(
  session: Session | null,
  rawRepoIds: unknown,
): Promise<BatchResult> {
  if (!session || !(await isReviewerEmail(session.email))) {
    return { ok: false, error: "You are not signed in as a reviewer." };
  }
  if (!Array.isArray(rawRepoIds) || rawRepoIds.length === 0 || rawRepoIds.length > MAX_BATCH) {
    return { ok: false, error: `Pick between 1 and ${MAX_BATCH} repositories.` };
  }

  const results: BatchItem[] = [];
  const seen = new Set<number>();
  for (const raw of rawRepoIds) {
    const repoId = Number(raw);
    if (!Number.isSafeInteger(repoId) || repoId <= 0) {
      results.push({ repoId: raw, ok: false, error: "That repository id is not valid." });
      continue;
    }
    if (seen.has(repoId)) {
      results.push({ repoId, ok: false, error: "Listed more than once." });
      continue;
    }
    seen.add(repoId);

    results.push(
      await db.transaction(async (tx): Promise<BatchItem> => {
        // FOR SHARE holds the grant against a revocation webhook until the enqueue commits.
        const [repository] = await tx
          .select({
            fullName: connectedRepository.fullName,
            isPrivate: connectedRepository.isPrivate,
            contentsPermission: githubInstallation.contentsPermission,
          })
          .from(connectedRepository)
          .innerJoin(githubInstallation, eq(connectedRepository.installationId, githubInstallation.id))
          .where(
            and(
              eq(connectedRepository.repoId, repoId),
              eq(connectedRepository.active, true),
              isNull(connectedRepository.archivedAt),
              isNull(githubInstallation.suspendedAt),
              isNull(githubInstallation.deletedAt),
            ),
          )
          .limit(1)
          .for("share");
        if (!repository) return { repoId, ok: false, error: "Not connected right now." };
        if (privateRepoPolicyRefused(repository)) {
          return { repoId, ok: false, error: "Private repository without Contents: read." };
        }
        await enqueue(
          {
            repoId,
            repoFullName: repository.fullName,
            sourceRef: `https://github.com/${repository.fullName}.git`,
          },
          tx,
        );
        return { repoId, ok: true };
      }),
    );
  }
  return { ok: true, results };
}
