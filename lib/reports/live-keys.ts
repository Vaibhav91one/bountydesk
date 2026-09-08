import type { QueryClient } from "@tanstack/react-query";

import type { CaseLiveView } from "@/lib/reports/case-view";
import {
  activeReportsQueryKey,
  caseStatusQueryKey,
  homeSummaryQueryKey,
  queueQueryKey,
  reportsIndexQueryKey,
} from "@/lib/reports/status-query";

/**
 * What a reviewer's decision does to every cached view of that report.
 *
 * The client mirror of revalidateReportViews in app/review/actions.ts, and it exists for the
 * same reason: a decision changes the case file, the board and the reports index at once, and
 * three call sites each remembering to refresh their own is three chances to forget one.
 */

/**
 * Write the decision into the cached view immediately, before the refetch lands.
 *
 * The server action has already committed by the time this runs, so this is not a guess about
 * what will happen; it is the same fact, applied a round trip earlier. Without it the approval
 * button sits saying "Approval needed" for as long as the refetch takes, which is exactly the
 * moment a reviewer is watching to see whether their click did anything.
 *
 * Deliberately partial. Only the fields the decision itself settles are touched, and the
 * refetch behind it supplies everything the server derives (the delivery row, the lifecycle
 * note naming the reviewer, the state the submission worker moves the report to).
 */
export function applyDecisionOptimistically(
  client: QueryClient,
  reportId: string,
  decision: "APPROVED" | "DENIED",
): void {
  client.setQueryData<CaseLiveView>(caseStatusQueryKey(reportId), (current) => {
    if (!current) return current;

    return {
      ...current,
      approvalDecision: decision,
      // The pending call has been answered. This is what closes the approval dialog and opens
      // the read-only verdict record in its place, in one render rather than two.
      awaitingVerdictId: null,
      stateLabel: decision === "APPROVED" ? "Approved" : "Denied",
      steps: current.steps.map((step) =>
        step.key === "approval"
          ? {
              ...step,
              state: "done" as const,
              note: decision === "APPROVED" ? "Approved" : "Denied",
              mascot: decision === "DENIED" ? ("denied" as const) : step.mascot,
            }
          : step,
      ),
    };
  });
}

/** Refetch every surface a decision touches. */
export async function refreshReportViews(
  client: QueryClient,
  reportId: string,
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: caseStatusQueryKey(reportId) }),
    client.invalidateQueries({ queryKey: queueQueryKey() }),
    client.invalidateQueries({ queryKey: reportsIndexQueryKey() }),
    // Both poll slowly, because on their own they are ambient. A decision is the one moment
    // they are certain to be wrong, and waiting out an interval to correct the count a
    // reviewer just changed is the version of this that feels broken.
    client.invalidateQueries({ queryKey: homeSummaryQueryKey() }),
    client.invalidateQueries({ queryKey: activeReportsQueryKey() }),
  ]);
}
