import { db, desc, eq, inArray, report, sql, targetProfile } from "@/lib/db";
import { TERMINAL_STATES } from "@/lib/reports/states";
import type { ReportState } from "@/lib/reports/states";

/**
 * The read model behind the review queue.
 *
 * Display only. Nothing here decides anything: the approval gate re-reads its own rows under a
 * lock in app/review/actions.ts at the moment it matters, and a card that says "awaiting
 * approval" is a claim about the last time this query ran, not a permission.
 */

export type VerdictOutcome = "REPRODUCED" | "NOT_REPRODUCED" | "INCONCLUSIVE" | "ANALYSIS_ONLY";

export type QueueCard = {
  id: string;
  title: string;
  /** "#482" for a GitHub issue, else the first segment of the id. Short enough to scan. */
  sourceLabel: string;
  /** null means no reproduction target is bound, so this report cannot be reproduced. */
  targetName: string | null;
  state: ReportState;
  /** The latest revision's outcome. null means no verdict has been drafted yet. */
  outcome: VerdictOutcome | null;
  /**
   * session_event rows, which is the run's own step log.
   *
   * Deliberately not called "evidence". verdict.evidence is a single reason string today,
   * because no sandbox work is built, and a count of it would be a count of one.
   */
  eventCount: number;
  updatedAt: Date;
  /** The exact verdict a reviewer would answer. Only ever set in AWAITING_APPROVAL. */
  awaitingVerdictId: string | null;
};

export type QueueColumn = {
  key: string;
  label: string;
  states: ReportState[];
  /** Every report in these states, not just the ones returned. */
  total: number;
  cards: QueueCard[];
};

/** How many cards a column will render before it stops and says so. */
export const COLUMN_LIMIT = 50;

/**
 * The board's columns, and the lifecycle states each one holds.
 *
 * Six rather than the wireframe's five. The wireframe predates the frozen enum in
 * docs/decisions.md, which has a state it does not: ANALYSIS_ONLY is not awaiting approval,
 * because there is no verdict to sign. A report reaches it when reproduction could not run at
 * all, and a human decides what happens next. Folding it into another column would misstate
 * that, so it gets its own.
 *
 * Every one of the ten states appears exactly once. A report that fell through the gaps would
 * be a report nobody can see.
 */
export const COLUMNS: { key: string; label: string; states: ReportState[] }[] = [
  { key: "triaging", label: "Triaging", states: ["TRIAGING"] },
  { key: "reproducing", label: "Reproducing", states: ["REPRODUCING"] },
  { key: "analysis-only", label: "Analysis only", states: ["ANALYSIS_ONLY"] },
  { key: "awaiting-approval", label: "Awaiting approval", states: ["AWAITING_APPROVAL"] },
  { key: "delivered", label: "Delivered", states: ["DELIVERING", "DELIVERED"] },
  {
    key: "closed",
    label: "Closed",
    states: ["DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"],
  },
];

/** "github:123456:issue:482" is what intake writes. Anything else is shown as a short id. */
export function sourceLabel(sourceRef: string, id: string): string {
  const issue = /^github:\d+:issue:(\d+)$/.exec(sourceRef);
  return issue ? `#${issue[1]}` : `#${id.slice(0, 8)}`;
}

async function cardsFor(states: ReportState[]): Promise<QueueCard[]> {
  const rows = await db
    .select({
      id: report.id,
      title: report.title,
      sourceRef: report.sourceRef,
      state: report.state,
      updatedAt: report.updatedAt,
      targetName: targetProfile.name,
      // Correlated rather than joined: verdict is revised by inserting the next revision, so a
      // plain join would return every past draft and multiply the row out.
      outcome: sql<VerdictOutcome | null>`(
        select v.outcome from verdict v
        where v.report_id = ${report.id}
        order by v.revision desc
        limit 1
      )`,
      eventCount: sql<number>`(
        select count(*)::int from session_event e where e.report_id = ${report.id}
      )`,
      // agent_session_pending_all_or_none keeps the four pending columns inseparable, so
      // reading either one answers the question. This reads the thread, the same half
      // app/review/page.tsx tests, so the card and that page agree by construction.
      pendingVerdictId: sql<string | null>`(
        select s.pending_verdict_id from agent_session s
        where s.report_id = ${report.id} and s.pending_thread_id is not null
        limit 1
      )`,
    })
    .from(report)
    .leftJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
    .where(inArray(report.state, states))
    .orderBy(desc(report.updatedAt))
    .limit(COLUMN_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    sourceLabel: sourceLabel(row.sourceRef, row.id),
    targetName: row.targetName,
    state: row.state,
    outcome: row.outcome,
    eventCount: row.eventCount,
    updatedAt: row.updatedAt,
    awaitingVerdictId: row.state === "AWAITING_APPROVAL" ? row.pendingVerdictId : null,
  }));
}

/**
 * Every column, with its true total and at most COLUMN_LIMIT cards.
 *
 * One query per column plus one for the counts. A window function would do it in a single
 * round trip, but per-column limits inside a partition are the kind of query nobody reads
 * twice, and each of these is an index lookup on report_state_idx against a table that holds
 * one row per report.
 *
 * The totals come from a separate grouped count rather than from the cards, so a column that
 * hit the limit still knows what it is hiding.
 */
export async function listQueue(): Promise<QueueColumn[]> {
  const counts = await db
    .select({ state: report.state, total: sql<number>`count(*)::int` })
    .from(report)
    .groupBy(report.state);

  const byState = new Map(counts.map((row) => [row.state, row.total]));
  const cards = await Promise.all(COLUMNS.map((column) => cardsFor(column.states)));

  return COLUMNS.map((column, index) => ({
    ...column,
    total: column.states.reduce((sum, state) => sum + (byState.get(state) ?? 0), 0),
    cards: cards[index],
  }));
}

/**
 * Which column a state belongs to, derived from COLUMNS rather than restated.
 *
 * The sidebar colours a report by its phase and the board colours a column by the same name, so
 * a second table here would be a second chance for the two to disagree.
 */
export function phaseOf(state: ReportState): string {
  const column = COLUMNS.find((c) => c.states.includes(state));
  // Unreachable while the test asserting every state is covered keeps passing, and cheaper to
  // answer honestly than to assert a non-null and be wrong later.
  return column?.key ?? "closed";
}

export type ActiveReport = {
  id: string;
  title: string;
  state: ReportState;
  phase: string;
};

/**
 * The reports in flight, for the sidebar. Most urgent first.
 *
 * Awaiting approval sorts ahead of everything else because it is the only state that is waiting
 * on the person reading the sidebar; the rest is recency. Terminal reports are excluded: a list
 * of what needs attention should not be padded with what is finished.
 */
export async function listActiveReports(limit = 5): Promise<ActiveReport[]> {
  const rows = await db
    .select({ id: report.id, title: report.title, state: report.state })
    .from(report)
    .where(sql`${report.state} not in ${TERMINAL_STATES}`)
    .orderBy(sql`(${report.state} = 'AWAITING_APPROVAL') desc`, desc(report.updatedAt))
    .limit(limit);

  return rows.map((row) => ({ ...row, phase: phaseOf(row.state) }));
}
