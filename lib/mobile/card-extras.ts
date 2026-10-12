import { db, eq, inArray, report, sql, targetProfile, type Executor } from "@/lib/db";

import { deliveryFailureReason, targetVersion, topSeverity, type MobileSeverity } from "./fields";

/** The fields a phone card shows beyond the shared queue read model. */
export type CardExtras = {
  severity: MobileSeverity | null;
  targetVersion: string | null;
  failureReason: string | null;
};

const NONE: CardExtras = { severity: null, targetVersion: null, failureReason: null };

export function extrasFor(extras: Map<string, CardExtras>, id: string): CardExtras {
  return extras.get(id) ?? NONE;
}

/**
 * Severity, target version and failure reason for a page of reports, in one query.
 *
 * Kept off the shared QueueCard on purpose: the web board and index read that type too and have
 * no use for these. The latest verdict and delivery are picked the way queue.ts picks them
 * (highest revision, newest delivery row), so a card cannot show a severity from a draft the
 * reviewer is no longer looking at.
 */
export async function readCardExtras(ids: string[], tx: Executor = db): Promise<Map<string, CardExtras>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: report.id,
      targetName: targetProfile.name,
      targetConfig: targetProfile.config,
      evidence: sql<unknown>`(
        select v.evidence from verdict v
        where v.report_id = ${report.id}
        order by v.revision desc
        limit 1
      )`,
      deliveryState: sql<string | null>`(
        select d.state from outbound_delivery d
        where d.verdict_id = (
          select v.id from verdict v where v.report_id = ${report.id} order by v.revision desc limit 1
        )
        order by d.updated_at desc
        limit 1
      )`,
      deliveryError: sql<string | null>`(
        select d.last_error from outbound_delivery d
        where d.verdict_id = (
          select v.id from verdict v where v.report_id = ${report.id} order by v.revision desc limit 1
        )
        order by d.updated_at desc
        limit 1
      )`,
      deliveryHeld: sql<boolean | null>`(
        select d.requires_human_review from outbound_delivery d
        where d.verdict_id = (
          select v.id from verdict v where v.report_id = ${report.id} order by v.revision desc limit 1
        )
        order by d.updated_at desc
        limit 1
      )`,
    })
    .from(report)
    .leftJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
    .where(inArray(report.id, ids));

  return new Map(
    rows.map((row) => [
      row.id,
      {
        severity: topSeverity(row.evidence),
        targetVersion: targetVersion(row.targetName, row.targetConfig),
        failureReason: deliveryFailureReason({
          state: row.deliveryState,
          lastError: row.deliveryError,
          requiresHumanReview: row.deliveryHeld,
        }),
      },
    ]),
  );
}
