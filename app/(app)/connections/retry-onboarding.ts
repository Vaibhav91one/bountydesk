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
import { privateRepoPolicyRefused } from "@/lib/github/repo-access";

export type RetryResult = { ok: true } | { ok: false; error: string };

/**
 * Restart a FAILED or UNSUPPORTED onboarding from the beginning, the button form of
 * scripts/enqueue-onboarding.ts.
 *
 * UNSUPPORTED is an honest refusal from the classifier, but it describes the source at the commit it
 * read. A repository whose owner has since fixed what made it unbuildable has no other way back:
 * automatic enqueues (a reconnect webhook) deliberately leave UNSUPPORTED alone so a repository that
 * truly cannot be packaged is not rebuilt in a loop. So a reviewer can ask for it here, and the
 * requeue clears the resolved commit, so the new source is resolved and classified again.
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
    if (!repository) {
      return { ok: false, error: "That repository is not connected right now, so it cannot be onboarded." };
    }
    if (privateRepoPolicyRefused(repository)) {
      return {
        ok: false,
        error:
          "That repository is private and the GitHub App has not been granted Contents: read, so it cannot be cloned. " +
          "Accept the Contents: read permission on the installation and onboarding starts on its own.",
      };
    }

    const [onboarding] = await tx
      .select({ state: targetOnboarding.state })
      .from(targetOnboarding)
      .where(eq(targetOnboarding.repoId, repoId))
      .limit(1)
      .for("update");
    if (onboarding?.state !== "FAILED" && onboarding?.state !== "UNSUPPORTED") {
      return { ok: false, error: "Only a failed or unsupported onboarding can be retried." };
    }

    await enqueue(
      {
        repoId,
        repoFullName: repository.fullName,
        sourceRef: `https://github.com/${repository.fullName}.git`,
      },
      tx,
      { requeueUnsupported: true },
    );
    return { ok: true };
  });
}
