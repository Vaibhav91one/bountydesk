import { approvalDecision, db, desc, eq, report, verdict } from "@/lib/db";

/**
 * The held-out sample a future dedup or triage quality measurement reads from: only verdicts a
 * human actually decided on, never a draft, an agent-only claim, or a verdict still awaiting
 * approval.
 *
 * Deliberately not a new table. approval_decision already is the confirmed-outcome ledger: every
 * row in it was written by a human's Approve or Deny click (app/review/actions.ts's decide()),
 * and nothing else writes to it. Duplicating that into a second table would be a copy to keep in
 * sync for no reason; an inner join through it is what structurally guarantees an unconfirmed
 * verdict can never appear here, rather than a filter that a future query could forget to apply.
 *
 * This is the sample, not the measurement: what it measures dedup and triage quality against, and
 * how, is open-ended future work (#347) this only provides the substrate for.
 */
export type ConfirmedOutcomeSample = {
  reportId: string;
  verdictId: string;
  /** The verdict's own outcome: REPRODUCED, NOT_REPRODUCED, INCONCLUSIVE, or ANALYSIS_ONLY. */
  outcome: string;
  /** The human's decision on that outcome: APPROVED or DENIED. */
  decision: string;
  title: string;
  body: string;
  decidedAt: Date;
};

export async function confirmedOutcomeSample(limit = 500): Promise<ConfirmedOutcomeSample[]> {
  return db
    .select({
      reportId: report.id,
      verdictId: verdict.id,
      outcome: verdict.outcome,
      decision: approvalDecision.decision,
      title: report.title,
      body: report.body,
      decidedAt: approvalDecision.decidedAt,
    })
    .from(approvalDecision)
    .innerJoin(verdict, eq(approvalDecision.verdictId, verdict.id))
    .innerJoin(report, eq(verdict.reportId, report.id))
    .orderBy(desc(approvalDecision.decidedAt))
    .limit(limit);
}
