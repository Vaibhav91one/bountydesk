import { isReviewerEmail } from "@/lib/auth/reviewers";
import type { Session } from "@/lib/auth/session";
import { enqueue } from "@/lib/build-onboarding/queue";
import {
  and,
  connectedRepository,
  db,
  eq,
  githubInstallation,
  isNull,
  targetOnboarding,
} from "@/lib/db";

export type RetryResult = { ok: true } | { ok: false; error: string };

/**
 * Restart a FAILED onboarding from the beginning, the button form of scripts/enqueue-onboarding.ts.
 *
 * Only FAILED. UNSUPPORTED is an honest refusal from the classifier rather than a step that ran
 * out of attempts, and enqueue() deliberately leaves it untouched, so offering a retry there would
 * be a button that does nothing. A repository whose source has changed since can be disconnected
 * and reconnected, which is a new onboarding rather than a retry.
 *
 * The repository name, and the clone URL built from it, come from connected_repository, never from
 * the client: the form carries only a repo id, and the build worker clones whatever sourceRef this
 * writes. The grant is re-read here rather than trusted from the list the reviewer was looking at,
 * so a repository removed, archived or suspended since cannot be sent back into a build.
 */
export async function retryOnboardingRequest(
  session: Session | null,
  rawRepoId: unknown,
): Promise<RetryResult> {
  // Re-checked here, not only at sign-in, so a reviewer taken off the list cannot retry with a
  // still-valid cookie (the same rule as approveOnboardingRequest).
  if (!session || !(await isReviewerEmail(session.email))) {
    return { ok: false, error: "You are not signed in as a reviewer." };
  }

  const repoId = Number(rawRepoId);
  if (!Number.isSafeInteger(repoId) || repoId <= 0) {
    return { ok: false, error: "That repository id is not valid." };
  }

  return db.transaction(async (tx) => {
    // FOR SHARE holds the grant against a revocation webhook until the requeue commits, in the same
    // connected_repository-then-target_onboarding order the connect webhook locks them in.
    const [repository] = await tx
      .select({ fullName: connectedRepository.fullName })
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
    if (!repository) {
      return { ok: false, error: "That repository is not connected right now, so it cannot be onboarded." };
    }

    const [onboarding] = await tx
      .select({ state: targetOnboarding.state })
      .from(targetOnboarding)
      .where(eq(targetOnboarding.repoId, repoId))
      .limit(1)
      .for("update");
    if (onboarding?.state !== "FAILED") {
      return { ok: false, error: "Only a failed onboarding can be retried." };
    }

    await enqueue(
      {
        repoId,
        repoFullName: repository.fullName,
        sourceRef: `https://github.com/${repository.fullName}.git`,
      },
      tx,
    );
    return { ok: true };
  });
}
