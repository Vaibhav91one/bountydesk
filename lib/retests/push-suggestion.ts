import {
  and,
  connectedRepository,
  db,
  desc,
  eq,
  report,
  retest,
  targetProfile,
  verdict,
  type Executor,
} from "@/lib/db";
import { hasActiveRepositoryGrant, loadRepositoryGrantSnapshot } from "@/lib/targets/repository-grant";
import { RETESTABLE_STATES } from "./retest";

/** The full 40-character SHA and the branch it was pushed to, surfaced as a one-click retest suggestion. */
export type PushSuggestion = {
  /** Full 40-character commit SHA pushed to the default branch. */
  commitSha: string;
  /** The SHA truncated for display in the retest panel. */
  shortSha: string;
  /** The default branch name the push landed on, for the suggestion text. */
  branch: string;
};

/**
 * A push-triggered retest suggestion for a REPRODUCED report, if one is owed.
 *
 * The suggestion appears only when all of these hold:
 *   - the report is REPRODUCED and in a deliverable state (DELIVERING or DELIVERED),
 *   - the report's connected repository is public, has a live grant,
 *   - that repository has a latest_pushed_commit_sha from a push webhook,
 *   - the pushed commit differs from the target profile's pinned commit,
 *   - no retest already exists for that verdict and commit.
 *
 * Private repositories are excluded: a private clone needs an installation token inside the
 * build sandbox, which the upload/retest path does not have (POLICY_REFUSED, same as private
 * reproduction itself). A suspended, deleted, or removed installation or repository has no live
 * grant, so it surfaces no suggestion.
 *
 * SUGGEST ONLY: a push never starts a retest by itself. The case file shows a one-click
 * button that calls startRetest with the full SHA. startRetest re-checks the report, the
 * writer, and the grant before doing anything.
 */
export async function readPushSuggestion(
  reportId: string,
  { tx = db }: { tx?: Executor } = {},
): Promise<PushSuggestion | null> {
  const [row] = await tx
    .select({
      state: report.state,
      isPrivate: connectedRepository.isPrivate,
      latestPushedCommitSha: connectedRepository.latestPushedCommitSha,
      latestPushedBranch: connectedRepository.latestPushedBranch,
      pinnedCommitSha: targetProfile.resolvedCommitSha,
    })
    .from(report)
    .leftJoin(connectedRepository, eq(report.connectedRepositoryId, connectedRepository.id))
    .leftJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
    .where(eq(report.id, reportId))
    .limit(1);

  if (!row) return null;
  // Private repos are excluded: retest uses the upload path, which cannot hold an
  // installation token for a private clone. This mirrors canOfferRetest and startRetest.
  if (row.isPrivate !== false) return null;
  // Only deliverable REPRODUCED reports get a suggestion.
  if (!RETESTABLE_STATES.includes(row.state)) return null;
  if (!row.latestPushedCommitSha || !row.latestPushedBranch || !row.pinnedCommitSha) return null;

  // The pushed commit must differ from the pinned commit. They are both SHAs,
  // so a case-insensitive comparison is correct.
  if (row.latestPushedCommitSha.toLowerCase() === row.pinnedCommitSha.toLowerCase()) return null;

  // The latest verdict is the one the suggestion keys off of: its id anchors any
  // existing retest row.
  const [latest] = await tx
    .select({ id: verdict.id, outcome: verdict.outcome })
    .from(verdict)
    .where(eq(verdict.reportId, reportId))
    .orderBy(desc(verdict.revision))
    .limit(1);
  // Only a REPRODUCED verdict has ever had a target built for it; anything else
  // has no pinned commit to compare against.
  if (!latest || latest.outcome !== "REPRODUCED") return null;

  const grant = await loadRepositoryGrantSnapshot(reportId, tx);
  if (!grant || !hasActiveRepositoryGrant(grant)) return null;

  // No existing retest at this commit for this verdict: the unique index on
  // (original_verdict_id, commit_sha) enforces this for startRetest, but the
  // suggestion should vanish once a retest is in flight so the case file does
  // not show a stale button.
  const [existing] = await tx
    .select({ id: retest.id })
    .from(retest)
    .where(
      and(
        eq(retest.originalVerdictId, latest.id),
        eq(retest.commitSha, row.latestPushedCommitSha),
      ),
    )
    .limit(1);
  if (existing) return null;

  return {
    commitSha: row.latestPushedCommitSha,
    shortSha: row.latestPushedCommitSha.slice(0, 12),
    branch: row.latestPushedBranch,
  };
}
