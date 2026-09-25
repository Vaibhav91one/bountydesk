import { agentSession, and, db, eq, inArray, report, sql, type Executor } from "@/lib/db";

import { retireReports, type RetireOutcome } from "./retire";

/**
 * How long a report may sit untouched in an abandonable state before the sweeper expires it.
 *
 * 30 days is the same window a human reviewer gets to notice an outside report waiting at the
 * gate; past it, nobody is coming. It is a named constant so a deployment can shorten it without
 * hunting through a query.
 */
export const EXPIRY_TTL_DAYS = 30;

/**
 * The only states an abandoned report may be expired from. Both are pre-investigation resting
 * points where nothing is in flight: NEEDS_DECISION waits for a reviewer to admit an outside
 * report, TRIAGING waits for the first run to pick it up. Everything else is deliberately absent:
 * REPRODUCING / AWAITING_APPROVAL / DELIVERING are in flight, ANALYSIS_ONLY holds a verdict a
 * human still owes a decision on, and the five terminal states are already done.
 */
export const EXPIRABLE_STATES = ["NEEDS_DECISION", "TRIAGING"] as const;

/** turn_status values that mean a live investigation still owns the report; see agent_session. */
const ACTIVE_TURN_STATUSES = ["RUNNING", "INVESTIGATING", "AWAITING_APPROVAL_HARNESS"] as const;

function expirable() {
  return and(
    inArray(report.state, [...EXPIRABLE_STATES]),
    // now() is the DB clock; updatedAt is bumped by every transition, so a state that has not
    // moved in the TTL is genuinely untouched.
    sql`${report.updatedAt} < now() - make_interval(days => ${EXPIRY_TTL_DAYS})`,
    // Never expire a report a live investigation still owns, even if its state lags in TRIAGING.
    sql`not exists (
      select 1 from ${agentSession}
      where ${agentSession.reportId} = ${report.id}
        and ${agentSession.turnStatus} in (${sql.join(
          ACTIVE_TURN_STATUSES.map((s) => sql`${s}`),
          sql`, `,
        )})
    )`,
  );
}

/**
 * The sweep's condition, re-read inside retireReports' locked transaction. The candidate select
 * runs earlier and outside it, so a run that started, or a transition that bumped updatedAt, in
 * between would otherwise still be expired from a state that merely looks unchanged.
 */
export async function stillExpirable(tx: Executor, reportId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: report.id })
    .from(report)
    .where(and(eq(report.id, reportId), expirable()));
  return rows.length > 0;
}

export type SweepExpiredReportsResult = {
  candidates: number;
  outcomes: RetireOutcome[];
};

/**
 * Expire reports abandoned past the TTL. Bounded and idempotent: it selects at most `limit`
 * candidates, and retireReports compare-and-swaps on the state it re-reads under a row lock, so a
 * report a worker moved between the select and the write is skipped, not overwritten. Running it
 * twice in a row expires nothing the first pass already moved out of an expirable state.
 *
 * The cutoff is `now()` from the database, not the app clock, so a worker whose clock drifts
 * cannot expire a report early or spare one late.
 */
export async function sweepExpiredReports(
  opts: { limit?: number; commit?: boolean } = {},
): Promise<SweepExpiredReportsResult> {
  const limit = opts.limit ?? 100;
  const commit = opts.commit ?? true;

  const candidates = await db
    .select({ id: report.id })
    .from(report)
    .where(expirable())
    .limit(limit);

  const ids = candidates.map((c) => c.id);
  if (ids.length === 0) return { candidates: 0, outcomes: [] };

  const outcomes = await retireReports(ids, {
    reason: `expiry sweep: abandoned longer than ${EXPIRY_TTL_DAYS} days`,
    to: "EXPIRED",
    commit,
    stillEligible: stillExpirable,
  });

  return { candidates: ids.length, outcomes };
}
