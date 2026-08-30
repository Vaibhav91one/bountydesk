import { agentSession, approvalDecision, db, eq, isNull, report, sql, targetProfile } from "@/lib/db";
import { TERMINAL_STATES } from "@/lib/reports/states";

/**
 * The numbers on the home cards.
 *
 * Counts only. The home page is a way in to the screens that hold the detail, so it says how
 * much is behind each door and nothing about what is there; a card that summarised a verdict
 * would be a fourth place for the same claim to drift.
 *
 * Read in one transaction for the reason the board is: five counts taken at five moments can
 * add up to a page that describes no moment at all.
 */
export type HomeSummary = {
  reports: number;
  open: number;
  /** Reports a reviewer can actually answer right now, not merely AWAITING_APPROVAL. */
  awaiting: number;
  targets: number;
  decisions: number;
};

export async function readHomeSummary(): Promise<HomeSummary> {
  return db.transaction(
    async (tx) => {
      const terminal = sql.join(
        TERMINAL_STATES.map((state) => sql`${state}`),
        sql`, `,
      );

      /**
       * A join rather than a correlated subquery.
       *
       * Drizzle renders a column inside an sql template without its table prefix, so an outer
       * reference inside a subquery resolves against the subquery's own scope instead: the
       * predicate compares agent_session.report_id to agent_session.id and is never true, and
       * the count comes back zero with no error to notice. A join makes Drizzle qualify both
       * sides, and agent_session.report_id is unique so it cannot multiply a report's row.
       */
      const [counts] = await tx
        .select({
          reports: sql<number>`count(*)::int`,
          open: sql<number>`count(*) filter (where ${report.state} not in (${terminal}))::int`,
          awaiting: sql<number>`count(*) filter (
            where ${report.state} = 'AWAITING_APPROVAL'
              and ${agentSession.pendingThreadId} is not null
              and ${agentSession.pendingVerdictId} is not null
          )::int`,
        })
        .from(report)
        .leftJoin(agentSession, eq(agentSession.reportId, report.id))
        // A soft-hidden test report must not inflate the home cards either.
        .where(isNull(report.hiddenAt));

      const [targets] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(targetProfile);

      const [decisions] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(approvalDecision);

      return {
        reports: counts?.reports ?? 0,
        open: counts?.open ?? 0,
        awaiting: counts?.awaiting ?? 0,
        targets: targets?.total ?? 0,
        decisions: decisions?.total ?? 0,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
