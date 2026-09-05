import { randomUUID } from "node:crypto";

import { agentSession, db, eq, report, type Executor } from "@/lib/db";
import type { AnalysisContext, AnalysisDriver } from "@/lib/jobs/worker";
import {
  recordEvent,
  transition,
  type ReportState,
} from "@/lib/reports/lifecycle";
import { ensureInitialVerdict } from "@/lib/verdicts/lifecycle";

const ANALYSIS_MESSAGE = `Automated reproduction was not run for this report. What follows is an analysis-only read of the report as submitted, not a check of whether the issue actually reproduces.`;

function buildPayload(verdictId: string): string {
  return `${ANALYSIS_MESSAGE}\n\n<!-- bountydesk-delivery:${verdictId} -->`;
}

const PRE_ANALYSIS_STATES: ReadonlySet<ReportState> = new Set([
  "TRIAGING",
  "REPRODUCING",
]);

async function ensureStubSession(reportId: string, tx: Executor = db): Promise<void> {
  await tx
    .insert(agentSession)
    .values({
      reportId,
      capabilityToken: `stub:${reportId}`,
      sessionId: `stub:${reportId}`,
      turnStatus: "DONE_NO_ACTION",
    })
    .onConflictDoNothing({ target: agentSession.reportId });
}

/**
 * The deterministic stand-in for a real TrueForge-backed driver. It never opens a session
 * and never touches the sandbox or scope guard: it only ever produces ANALYSIS_ONLY, so
 * there is nothing to scope-check and nothing to reproduce.
 */
export const stubAnalysisDriver: AnalysisDriver = {
  async ensureSession({ reportId, signal }: AnalysisContext): Promise<void> {
    if (signal.aborted) throw signal.reason;
    await ensureStubSession(reportId);

    await recordEvent(
      reportId,
      "analysis.stub_session.created",
      { provider: "stub", sessionId: `stub:${reportId}` },
      { idempotencyKey: `${reportId}:analysis.stub_session.created` },
    );
    if (signal.aborted) throw signal.reason;
  },

  async run({ reportId, signal }: AnalysisContext): Promise<void> {
    if (signal.aborted) throw signal.reason;

    await db.transaction(async (tx: Executor) => {
      await ensureStubSession(reportId, tx);

      // Locks the row so a concurrent or retried call cannot both see TRIAGING/REPRODUCING
      // and both try to write a verdict; the second one blocks here until the first commits
      // its transition, then sees the post-transition state and returns early below.
      const [row] = await tx
        .select({ id: report.id, state: report.state })
        .from(report)
        .where(eq(report.id, reportId))
        .for("update");

      if (!row)
        throw new Error(
          `stubAnalysisDriver.run: report ${reportId} does not exist`,
        );

      // An earlier attempt at this same job already carried the report past analysis. That
      // makes this call a no-op, which is what lets the worker retry it freely under a lost
      // or renewed lease.
      if (!PRE_ANALYSIS_STATES.has(row.state)) return;

      if (signal.aborted) throw signal.reason;

      const verdictId = randomUUID();
      const payload = buildPayload(verdictId);
      const verdict = await ensureInitialVerdict(
        {
          id: verdictId,
          reportId,
          outcome: "ANALYSIS_ONLY",
          summary: "Analysis-only result: automated reproduction was not run.",
          evidence: { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" },
          payload,
        },
        tx,
      );

      await transition(reportId, row.state, "ANALYSIS_ONLY", tx);
      await tx
        .update(agentSession)
        .set({
          turnStatus: "DONE_NO_ACTION",
          pendingVerdictId: verdict.id,
          pendingApprovedContentHash: verdict.contentHash,
          updatedAt: new Date(),
        })
        .where(eq(agentSession.reportId, reportId));

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
