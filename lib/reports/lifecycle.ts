import { db, eq, report, sessionEvent, sql, type Executor } from "@/lib/db";

import { canTransition, type ReportState } from "./states";

export * from "./states";

/** Raised when the report was not in the state the caller believed it was in. */
export class ReportStateConflictError extends Error {
  constructor(reportId: string, expected: ReportState, to: ReportState) {
    super(`report ${reportId} was not in ${expected}, so it cannot move to ${to}`);
    this.name = "ReportStateConflictError";
  }
}

/**
 * Move a report, checking the graph and then compare-and-swapping on the state we read.
 *
 * The `from` argument is not decoration: without it two workers that both read TRIAGING
 * could both write, and the second would silently overwrite the first. The update matches no
 * rows unless the report is still where the caller last saw it.
 */
export async function transition(
  reportId: string,
  from: ReportState,
  to: ReportState,
  tx: Executor = db,
): Promise<void> {
  if (!canTransition(from, to)) {
    throw new Error(`illegal report transition ${from} -> ${to} for report ${reportId}`);
  }

  const updated = await tx
    .update(report)
    .set({ state: to, updatedAt: new Date() })
    .where(sql`${report.id} = ${reportId} and ${report.state} = ${from}`)
    .returning({ id: report.id });

  if (updated.length === 0) throw new ReportStateConflictError(reportId, from, to);
}

export type NewReport = {
  channel: (typeof report.channel.enumValues)[number];
  sourceRef: string;
  title: string;
  body: string;
  reporterHandle: string | null;
  connectedRepositoryId: string;
  targetProfileId: string;
};

/**
 * Create the report for a delivery, or return the one that already exists.
 *
 * A worker can die after committing the report and before recording it on the job, so this
 * has to be safe to run twice. `(channel, source_ref)` is unique, which makes the database
 * the arbiter rather than a read-then-write in application code.
 */
export async function ensureReport(input: NewReport, tx: Executor = db): Promise<string> {
  const inserted = await tx
    .insert(report)
    .values(input)
    .onConflictDoNothing({ target: [report.channel, report.sourceRef] })
    .returning({ id: report.id });

  if (inserted.length > 0) return inserted[0].id;

  const [existing] = await tx
    .select({ id: report.id })
    .from(report)
    .where(sql`${report.channel} = ${input.channel} and ${report.sourceRef} = ${input.sourceRef}`)
    .limit(1);

  if (!existing) {
    throw new Error(`ensureReport: conflict on ${input.channel} ${input.sourceRef} but no row found`);
  }

  return existing.id;
}

/**
 * Append to the audit trail.
 *
 * ponytail: the sequence comes from max(seq) + 1 on the report, which is a race under
 * concurrent writers for one report. The unique (report_id, seq) index turns that race into
 * a failed insert rather than a gap or a duplicate, and the MVP runs one turn per report at
 * a time by design. If that changes, give this a per-report sequence generator.
 */
export async function recordEvent(
  reportId: string,
  type: string,
  data: Record<string, unknown> = {},
  tx: Executor = db,
): Promise<void> {
  await tx.insert(sessionEvent).values({
    reportId,
    seq: sql`(select coalesce(max(seq), 0) + 1 from session_event where report_id = ${reportId})`,
    type,
    data,
  });
}

export async function reportState(reportId: string, tx: Executor = db): Promise<ReportState | null> {
  const [row] = await tx
    .select({ state: report.state })
    .from(report)
    .where(eq(report.id, reportId))
    .limit(1);

  return row?.state ?? null;
}
