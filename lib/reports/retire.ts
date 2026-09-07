import { db, eq, report } from "@/lib/db";

import { recordEvent, transition } from "./lifecycle";
import { isTerminal, type ReportState } from "./states";

/**
 * Retire named reports: the operator path for smoke and synthetic rows that stayed live after a
 * test run and now sit in the queue looking like work.
 *
 * Retiring is a state move, never a delete. `verdict`, `approval_decision`, `session_event` and
 * `delivery_attempt` refuse DELETE at the database level and `report` carries restrict foreign
 * keys, so the row and its evidence stay exactly where they are; only the lifecycle state moves,
 * and the move is recorded as one more `session_event`.
 *
 * Reports are named by id and nothing else. Selecting by state or by age would eventually catch a
 * live report on a slow day, and there is no undo: CANCELLED and EXPIRED are terminal, so a
 * report retired by mistake cannot be brought back.
 */
export type RetirementState = Extract<ReportState, "CANCELLED" | "EXPIRED">;

export type RetireOutcome =
  | { reportId: string; status: "retired" | "would-retire"; from: ReportState }
  | { reportId: string; status: "already-terminal"; from: ReportState }
  | { reportId: string; status: "missing" };

export async function retireReports(
  reportIds: readonly string[],
  opts: { reason: string; to?: RetirementState; commit?: boolean },
): Promise<RetireOutcome[]> {
  const to = opts.to ?? "CANCELLED";
  const outcomes: RetireOutcome[] = [];

  for (const reportId of reportIds) {
    // One transaction per report, so a report that has moved under us fails on its own rather
    // than rolling back the ones already retired in the same run.
    const outcome = await db.transaction(async (tx): Promise<RetireOutcome> => {
      const [row] = await tx
        .select({ state: report.state })
        .from(report)
        .where(eq(report.id, reportId))
        .for("update");

      if (!row) return { reportId, status: "missing" };
      if (isTerminal(row.state)) {
        return { reportId, status: "already-terminal", from: row.state };
      }
      if (!opts.commit) return { reportId, status: "would-retire", from: row.state };

      // The state read inside this transaction is what transition compare-and-swaps on, so a
      // report that moved between the read and the write raises ReportStateConflictError instead
      // of being written over.
      await transition(reportId, row.state, to, tx);
      await recordEvent(reportId, "report.retired", { from: row.state, to, reason: opts.reason }, { tx });
      return { reportId, status: "retired", from: row.state };
    });

    outcomes.push(outcome);
  }

  return outcomes;
}
