import { randomUUID } from "node:crypto";

import { db, eq, report, type Executor } from "@/lib/db";
import type { AnalysisContext, AnalysisDriver } from "@/lib/jobs/worker";
import { recordEvent, transition, type ReportState } from "@/lib/reports/lifecycle";
import { computeContentHash } from "@/lib/verdicts/hash";
import { ensureInitialVerdict } from "@/lib/verdicts/lifecycle";

const ANALYSIS_MESSAGE = `Automated reproduction was not run for this report. What follows is an analysis-only read of the report as submitted, not a check of whether the issue actually reproduces. A person still needs to review this before any next step.`;

function buildPayload(verdictId: string): string {
  return `${ANALYSIS_MESSAGE}\n\n<!-- bountydesk-delivery:${verdictId} -->`;
}

const PRE_ANALYSIS_STATES: ReadonlySet<ReportState> = new Set(["TRIAGING", "REPRODUCING"]);

/**
 * The deterministic stand-in for a real TrueForge-backed driver. It never opens a session
 * and never touches the sandbox or scope guard: it only ever produces ANALYSIS_ONLY, so
 * there is nothing to scope-check and nothing to reproduce.
 */
export const stubAnalysisDriver: AnalysisDriver = {
  // ponytail: nothing to set up. There is no real session behind this stub, so recording a
  // session_event here would be an audit trail entry for something that never happened; that
  // is A4's job once a real TrueForge session exists.
  async ensureSession(): Promise<void> {},

  async run({ reportId, signal }: AnalysisContext): Promise<void> {
    if (signal.aborted) throw signal.reason;

    await db.transaction(async (tx: Executor) => {
      // Locks the row so a concurrent or retried call cannot both see TRIAGING/REPRODUCING
      // and both try to write a verdict; the second one blocks here until the first commits
      // its transition, then sees the post-transition state and returns early below.
      const [row] = await tx
        .select({ id: report.id, state: report.state })
        .from(report)
        .where(eq(report.id, reportId))
        .for("update");

      if (!row) throw new Error(`stubAnalysisDriver.run: report ${reportId} does not exist`);

      // An earlier attempt at this same job already carried the report past analysis. That
      // makes this call a no-op, which is what lets the worker retry it freely under a lost
      // or renewed lease.
      if (!PRE_ANALYSIS_STATES.has(row.state)) return;

      if (signal.aborted) throw signal.reason;

      const verdictId = randomUUID();
      const payload = buildPayload(verdictId);
      const contentHash = computeContentHash(payload);

      await ensureInitialVerdict(
        {
          id: verdictId,
          reportId,
          outcome: "ANALYSIS_ONLY",
          summary: "Analysis-only result: automated reproduction was not run.",
          evidence: { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" },
          payload,
          contentHash,
        },
        tx,
      );

      await transition(reportId, row.state, "ANALYSIS_ONLY", tx);
      await transition(reportId, "ANALYSIS_ONLY", "AWAITING_APPROVAL", tx);

      await recordEvent(
        reportId,
        "analysis.completed",
        { verdictId },
        { idempotencyKey: `${reportId}:analysis.completed`, tx },
      );

      if (signal.aborted) throw signal.reason;
    });
  },
};
