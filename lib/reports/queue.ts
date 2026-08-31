import {
  and,
  agentSession,
  connectedRepository,
  db,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  outboundDelivery,
  report,
  sql,
  targetProfile,
  type Executor,
} from "@/lib/db";
import { COLUMNS, phaseOf } from "@/lib/reports/columns";
import { isAgentInvestigating } from "@/lib/reports/case";
import { TERMINAL_STATES } from "@/lib/reports/states";

export { COLUMNS, phaseOf };
import type { ReportState } from "@/lib/reports/states";

/**
 * The read model behind the review queue.
 *
 * Display only. Nothing here decides anything: the approval gate re-reads its own rows under a
 * lock in app/review/actions.ts at the moment it matters, and a card that says "awaiting
 * approval" is a claim about the last time this query ran, not a permission.
 */

export type VerdictOutcome = "REPRODUCED" | "NOT_REPRODUCED" | "INCONCLUSIVE" | "ANALYSIS_ONLY";
export type DeliveryState = (typeof outboundDelivery.state.enumValues)[number];

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
  /** The outbox state for the newest delivery row, if approval has reached delivery. */
  deliveryState: DeliveryState | null;
  /**
   * session_event rows, which is the run's own step log.
   *
   * Deliberately not called "evidence". verdict.evidence is a single reason string today,
   * because no sandbox work is built, and a count of it would be a count of one.
   */
  eventCount: number;
  updatedAt: Date;
  /** The exact verdict a reviewer would answer. Also set for pending ANALYSIS_ONLY verdicts. */
  awaitingVerdictId: string | null;
  /** Whether an agent is actively working this report right now (see isAgentInvestigating). */
  investigating: boolean;
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


/** "github:123456:issue:482" is what intake writes. Anything else is shown as a short id. */
export function sourceLabel(sourceRef: string, id: string): string {
  const issue = /^github:\d+:issue:(\d+)$/.exec(sourceRef);
  return issue ? `#${issue[1]}` : `#${id.slice(0, 8)}`;
}

async function cardsFor(states: ReportState[], tx: Executor): Promise<QueueCard[]> {
  const rows = await tx
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
      // Gated on the verdict/hash pair, not the thread: a synthesized ANALYSIS_ONLY verdict (a
      // dead-end run) has a verdict awaiting approval but no TrueForge call, so its thread id is
      // null. The check constraint pairs pending_verdict_id with pending_approved_content_hash,
      // so pending_verdict_id alone answers the question and stays in step with case.ts.
      pendingVerdictId: sql<string | null>`(
        select s.pending_verdict_id from agent_session s
        where s.report_id = ${report.id} and s.pending_verdict_id is not null
        limit 1
      )`,
      deliveryState: sql<DeliveryState | null>`(
        select d.state from outbound_delivery d
        where d.report_id = ${report.id}
        order by d.updated_at desc
        limit 1
      )`,
      turnStatus: sql<string | null>`(
        select s.turn_status from agent_session s where s.report_id = ${report.id} limit 1
      )`,
      // Same event log eventCount reads, filtered to the poller's mirrored tool-call events:
      // the one signal isAgentInvestigating trusts that a RUNNING/INVESTIGATING turn has
      // actually done something, not just started (see lib/reports/case.ts).
      hasToolCallEvents: sql<boolean>`exists (
        select 1 from session_event e
        where e.report_id = ${report.id} and e.type like 'agent.tool_call:%'
      )`,
    })
    .from(report)
    .leftJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
    // Soft-hidden reports never reach a list surface. The board is a list.
    .where(and(inArray(report.state, states), isNull(report.hiddenAt)))
    .orderBy(desc(report.updatedAt))
    .limit(COLUMN_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    sourceLabel: sourceLabel(row.sourceRef, row.id),
    targetName: row.targetName,
    state: row.state,
    outcome: row.outcome,
    deliveryState: row.deliveryState,
    eventCount: row.eventCount,
    updatedAt: row.updatedAt,
    awaitingVerdictId:
      row.state === "AWAITING_APPROVAL" ||
      (row.state === "ANALYSIS_ONLY" && row.outcome === "ANALYSIS_ONLY")
        ? row.pendingVerdictId
        : null,
    investigating: isAgentInvestigating(row.turnStatus, row.outcome !== null, row.hasToolCallEvents),
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
 *
 * All seven reads share one repeatable-read transaction, which is what makes the board a
 * single moment rather than seven. Without it an intake landing between the count and the
 * cards renders a board that contradicts itself: a column showing cards above a total of zero,
 * or the whole screen claiming "No reports yet" while the card queries already found some.
 * Read-only, so there is nothing to retry on a serialisation failure.
 */
export async function listQueue(): Promise<QueueColumn[]> {
  return db.transaction(
    async (tx) => {
      const counts = await tx
        .select({ state: report.state, total: sql<number>`count(*)::int` })
        .from(report)
        // Counts must match the cards: a hidden report is off the board, total included.
        .where(isNull(report.hiddenAt))
        .groupBy(report.state);

      const byState = new Map(counts.map((row) => [row.state, row.total]));
      // Sequential rather than Promise.all: one transaction is one connection, and concurrent
      // queries on it would serialise anyway or error, depending on the driver.
      const cards: QueueCard[][] = [];
      for (const column of COLUMNS) cards.push(await cardsFor(column.states, tx));

      return COLUMNS.map((column, index) => ({
        ...column,
        total: column.states.reduce((sum, state) => sum + (byState.get(state) ?? 0), 0),
        cards: cards[index],
      }));
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
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
 * Reports with an answerable verdict sort ahead of everything else because they are waiting on
 * the person reading the sidebar; the rest is recency. Terminal reports are excluded: a list of
 * what needs attention should not be padded with what is finished.
 */
export async function listActiveReports(limit = 5): Promise<ActiveReport[]> {
  const rows = await db
    .select({ id: report.id, title: report.title, state: report.state })
    .from(report)
    .leftJoin(agentSession, eq(agentSession.reportId, report.id))
    // Spread because TERMINAL_STATES is a readonly tuple and the operator takes a mutable array.
    .where(and(notInArray(report.state, [...TERMINAL_STATES]), isNull(report.hiddenAt)))
    .orderBy(
      sql`(
        ${report.state} in ('AWAITING_APPROVAL', 'ANALYSIS_ONLY')
          and ${agentSession.pendingVerdictId} is not null
          and ${agentSession.pendingApprovedContentHash} is not null
      ) desc`,
      desc(report.updatedAt),
    )
    .limit(limit);

  return rows.map((row) => ({ ...row, phase: phaseOf(row.state) }));
}

/** How many rows the reports index reads. Enough that the filter is honest, bounded so it ends. */
export const INDEX_LIMIT = 200;

export type IndexRow = QueueCard & {
  /** "Vaibhav91one/juice-shop", or the channel when the report came in another way. */
  origin: string;
  createdAt: Date;
};

/**
 * Every report, newest change first, terminal ones included.
 *
 * The board deliberately hides closed work, which leaves a delivered report reachable only by
 * its URL. This is the list that does not hide anything, which is why it is a separate read
 * rather than a flag on listQueue: the two screens want opposite things.
 */
export async function listAllReports(limit = INDEX_LIMIT): Promise<IndexRow[]> {
  const rows = await db
    .select({
      id: report.id,
      title: report.title,
      sourceRef: report.sourceRef,
      state: report.state,
      channel: report.channel,
      repositoryFullName: connectedRepository.fullName,
      targetName: targetProfile.name,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      outcome: sql<VerdictOutcome | null>`(
        select v.outcome from verdict v
        where v.report_id = ${report.id}
        order by v.revision desc
        limit 1
      )`,
      eventCount: sql<number>`(
        select count(*)::int from session_event e where e.report_id = ${report.id}
      )`,
      awaitingVerdictId: sql<string | null>`(
        select s.pending_verdict_id from agent_session s
        where s.report_id = ${report.id} and s.pending_verdict_id is not null
        limit 1
      )`,
      deliveryState: sql<DeliveryState | null>`(
        select d.state from outbound_delivery d
        where d.report_id = ${report.id}
        order by d.updated_at desc
        limit 1
      )`,
      turnStatus: sql<string | null>`(
        select s.turn_status from agent_session s where s.report_id = ${report.id} limit 1
      )`,
      hasToolCallEvents: sql<boolean>`exists (
        select 1 from session_event e
        where e.report_id = ${report.id} and e.type like 'agent.tool_call:%'
      )`,
    })
    .from(report)
    .leftJoin(connectedRepository, eq(report.connectedRepositoryId, connectedRepository.id))
    .leftJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
    // Terminal reports still show here, hidden ones never do: this list is for what exists,
    // not what a run left behind for testing.
    .where(isNull(report.hiddenAt))
    .orderBy(desc(report.updatedAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    sourceLabel: sourceLabel(row.sourceRef, row.id),
    targetName: row.targetName,
    state: row.state,
    outcome: row.outcome,
    deliveryState: row.deliveryState,
    eventCount: row.eventCount,
    updatedAt: row.updatedAt,
    // Only a report that is genuinely waiting on a reviewer, the same pair the case file tests.
    awaitingVerdictId:
      row.state === "AWAITING_APPROVAL" ||
      (row.state === "ANALYSIS_ONLY" && row.outcome === "ANALYSIS_ONLY")
        ? row.awaitingVerdictId
        : null,
    investigating: isAgentInvestigating(row.turnStatus, row.outcome !== null, row.hasToolCallEvents),
    origin: row.repositoryFullName ?? row.channel,
    createdAt: row.createdAt,
  }));
}
