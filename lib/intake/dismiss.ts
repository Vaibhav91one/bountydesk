import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { inboundJob, report } from "@/lib/db/schema";
import type { Executor } from "@/lib/db";

/** The sourceRef intake writes for a GitHub issue, matched to `worker.ts`'s `parse`. */
export function githubIssueSourceRef(repoGithubId: number, issueNumber: number): string {
  return `github:${repoGithubId}:issue:${issueNumber}`;
}

/**
 * Hide any still-showing intake failure for a GitHub issue that was just closed. A dead-lettered
 * intake job otherwise sits in the board strip for a full 24 hours with no way to clear it; once
 * the reporter closes the issue there is nothing left to act on. This only stamps dismissed_at, so
 * the job keeps its DEAD_LETTER state and its place in the audit trail. Returns how many rows it
 * cleared, which is zero for an issue that never failed intake.
 */
export async function dismissIntakeJobsForClosedIssue(
  repoGithubId: number,
  issueNumber: number,
  tx?: Executor,
): Promise<number> {
  // The pool is imported lazily so the pure ref builder above stays importable without a
  // DATABASE_URL, the same reason jobs-read does it.
  const runner: Executor = tx ?? (await import("@/lib/db")).db;
  const sourceRef = githubIssueSourceRef(repoGithubId, issueNumber);
  const reports = await runner
    .select({ id: report.id })
    .from(report)
    .where(and(eq(report.channel, "github"), eq(report.sourceRef, sourceRef)));
  if (reports.length === 0) return 0;

  const cleared = await runner
    .update(inboundJob)
    .set({ dismissedAt: sql`now()` })
    .where(
      and(
        inArray(
          inboundJob.reportId,
          reports.map((r) => r.id),
        ),
        isNull(inboundJob.dismissedAt),
      ),
    )
    .returning({ id: inboundJob.id });
  return cleared.length;
}
