import { db, eq, inArray, report, sessionEvent, sql, type Executor } from "@/lib/db";

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
  /** The verified reply-to for a non-GitHub channel (email). Null for GitHub. */
  reporterContact?: string | null;
  /** The contact address when it passed SPF and DKIM for an outside sender; see report.verifiedSender. */
  verifiedSender?: string | null;
  /** Where the report starts. TRIAGING unless intake holds it at the gate (NEEDS_DECISION). */
  state?: ReportState;
  /** The earlier report this one replies to, when intake matched its thread headers. Display only. */
  repliesToReportId?: string | null;
  /** Null for a channel with no repository, e.g. email: the report stays analysis-only. */
  connectedRepositoryId: string | null;
  targetProfileId: string | null;
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
    .select({
      id: report.id,
      connectedRepositoryId: report.connectedRepositoryId,
      targetProfileId: report.targetProfileId,
    })
    .from(report)
    .where(sql`${report.channel} = ${input.channel} and ${report.sourceRef} = ${input.sourceRef}`)
    .limit(1);

  if (!existing) {
    throw new Error(`ensureReport: conflict on ${input.channel} ${input.sourceRef} but no row found`);
  }

  if (
    existing.connectedRepositoryId !== input.connectedRepositoryId ||
    existing.targetProfileId !== input.targetProfileId
  ) {
    throw new Error(
      `report identity ${input.channel} ${input.sourceRef} is already bound to another repository or target`,
    );
  }

  return existing.id;
}

/**
 * Find the report an inbound email reply threads to, or null.
 *
 * The tokens are the message ids from the reply's In-Reply-To and References headers, matched
 * against an existing email report's source_ref (email:<id>). Those headers are sender-controlled,
 * so a match links only when the parent report's verified_sender equals this reply's, both non-null:
 * that stops one reporter from threading a reply onto another reporter's report by quoting its id.
 * There is deliberately no subject fallback, which would cross-link every "Re: We received your
 * report". The result is a display link on the case file and authorizes nothing.
 */
export async function findRepliedToReport(
  parentTokens: string[],
  verifiedSender: string | null | undefined,
  tx: Executor = db,
): Promise<string | null> {
  const sender = verifiedSender?.trim().toLowerCase();
  if (!sender || parentTokens.length === 0) return null;

  const sourceRefs = parentTokens.map((token) => `email:${token}`);
  const [row] = await tx
    .select({ id: report.id })
    .from(report)
    .where(
      sql`${report.channel} = 'email'
        and ${inArray(report.sourceRef, sourceRefs)}
        and lower(${report.verifiedSender}) = ${sender}`,
    )
    .limit(1);

  return row?.id ?? null;
}

/** How many times a seq collision is retried before the write is allowed to fail. */
const SEQ_ALLOCATION_RETRIES = 25;

/** True for the unique violation on session_event_report_seq_key, wrapped by the driver or not. */
function isSeqUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint_name?: string; message?: string; cause?: unknown };
  const named = e?.constraint_name === "session_event_report_seq_key"
    || (e?.message?.includes("session_event_report_seq_key") ?? false);
  if (e?.code === "23505" && named) return true;
  return e?.cause ? isSeqUniqueViolation(e.cause) : false;
}

/**
 * Append to the audit trail.
 *
 * seq is the per-report max(seq) + 1, which two concurrent writers can read the same way and
 * then collide on the unique (report_id, seq) index. We serialise that without locking the
 * report row: sweepRecheckRuns and other callers hold investigation_run locks when they call in,
 * so locking the report row here would invert the report -> investigation_run order that
 * abandonVerdictConflict takes and deadlock. Instead the unique index is the arbiter. A colliding
 * insert is rejected, and we recompute the max and retry. Each attempt runs in its own savepoint
 * (or its own transaction when no `tx` is passed), so a rejected insert rolls back on its own and
 * leaves the caller's transaction usable for the retry.
 */
export async function recordEvent(
  reportId: string,
  type: string,
  data: Record<string, unknown> = {},
  {
    idempotencyKey,
    tx,
  }: { idempotencyKey?: string; tx?: Executor } = {},
): Promise<void> {
  const runner = tx ?? db;
  for (let attempt = 0; ; attempt++) {
    try {
      await runner.transaction(async (exec) => {
        const insert = exec.insert(sessionEvent).values({
          reportId,
          seq: sql`(select coalesce(max(seq), 0) + 1 from session_event where report_id = ${reportId})`,
          type,
          eventKey: idempotencyKey,
          data,
        });
        if (idempotencyKey) {
          await insert.onConflictDoNothing({
            target: [sessionEvent.reportId, sessionEvent.eventKey],
          });
        } else {
          await insert;
        }
      });
      return;
    } catch (err) {
      if (attempt < SEQ_ALLOCATION_RETRIES && isSeqUniqueViolation(err)) continue;
      throw err;
    }
  }
}

/**
 * Kept for callers that spell out the intent. recordEvent serialises seq allocation for every
 * writer through the unique index, so this is a plain alias with the idempotency key positional.
 */
export async function recordEventLocked(
  reportId: string,
  type: string,
  data: Record<string, unknown> = {},
  idempotencyKey?: string,
): Promise<void> {
  await recordEvent(reportId, type, data, { idempotencyKey });
}

export async function reportState(reportId: string, tx: Executor = db): Promise<ReportState | null> {
  const [row] = await tx
    .select({ state: report.state })
    .from(report)
    .where(eq(report.id, reportId))
    .limit(1);

  return row?.state ?? null;
}
