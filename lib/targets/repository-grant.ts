import { connectedRepository, eq, githubInstallation, report, targetProfile, type Executor } from "@/lib/db";

/**
 * Whether a report's bound target profile is still authorized to reproduce against, shared by
 * trueforge-driver.ts's deterministic pipeline and lib/mcp/publish-verdict.ts's agent-drafted
 * path so the two never drift on what counts as a live authorization.
 */
export type RepositoryGrantSnapshot = {
  targetProfileId: string;
  connectedRepositoryId: string | null;
  repoActive: boolean | null;
  repoArchivedAt: Date | null;
  repoTargetProfileId: string | null;
  installationSuspendedAt: Date | null;
  installationDeletedAt: Date | null;
};

/**
 * A target with no connected repository (the single pinned demo target) is always active. A
 * connected repository's grant is revoked by an uninstall, a suspension, or being repointed at
 * a different target profile -- any of which must stop a definitive verdict cold.
 */
export function hasActiveRepositoryGrant(target: RepositoryGrantSnapshot): boolean {
  if (!target.connectedRepositoryId) return true;
  return (
    target.repoActive === true &&
    target.repoArchivedAt === null &&
    target.repoTargetProfileId === target.targetProfileId &&
    target.installationSuspendedAt === null &&
    target.installationDeletedAt === null
  );
}

/**
 * Loads the current target-profile binding and repository grant for a report. Returns null
 * when the report has no bound target profile at all -- the same "no bound target, no
 * definitive outcome" gate trueforge-driver.ts's decideFreshVerdict enforces via its own,
 * wider select.
 */
export async function loadRepositoryGrantSnapshot(
  reportId: string,
  tx: Executor,
): Promise<RepositoryGrantSnapshot | null> {
  const [row] = await tx
    .select({
      targetProfileId: targetProfile.id,
      connectedRepositoryId: report.connectedRepositoryId,
      repoActive: connectedRepository.active,
      repoArchivedAt: connectedRepository.archivedAt,
      repoTargetProfileId: connectedRepository.targetProfileId,
      installationSuspendedAt: githubInstallation.suspendedAt,
      installationDeletedAt: githubInstallation.deletedAt,
    })
    .from(report)
    .innerJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
    .leftJoin(connectedRepository, eq(report.connectedRepositoryId, connectedRepository.id))
    .leftJoin(githubInstallation, eq(connectedRepository.installationId, githubInstallation.id))
    .where(eq(report.id, reportId))
    .limit(1);

  return row ?? null;
}
