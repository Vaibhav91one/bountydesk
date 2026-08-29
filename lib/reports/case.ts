import {
  agentSession,
  approvalDecision,
  connectedRepository,
  db,
  desc,
  eq,
  outboundDelivery,
  report,
  sessionEvent,
  targetProfile,
  verdict,
} from "@/lib/db";
import type { ReportState } from "@/lib/reports/states";

/**
 * Everything one report has to show, read in one snapshot.
 *
 * Display only, like queue.ts. The approval gate in app/review/actions.ts re-reads and locks
 * its own rows when a reviewer clicks, so nothing here is a permission: a page that says
 * "awaiting approval" is describing the moment it was rendered.
 *
 * What is absent matters as much as what is here. There is no sandbox, no canary result, no
 * artifact and no resource use, because none of that is built. verdict.evidence carries a
 * single reason string. The page says so rather than leaving a gap that reads like a value
 * that failed to load.
 */

export type CaseEvent = {
  seq: number;
  type: string;
  /** intake, worker, sandbox, oracle, control. Taken from the type's first segment. */
  channel: string;
  data: unknown;
  at: Date;
};

export type CaseVerdict = {
  id: string;
  outcome: string;
  summary: string;
  payload: string;
  contentHash: string;
  revision: number;
  /** Whatever the driver recorded. Today: { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" }. */
  evidence: unknown;
  createdAt: Date;
};

export type CaseFile = {
  id: string;
  title: string;
  body: string;
  channel: string;
  sourceRef: string;
  sourceLabel: string;
  /** The issue number alone, for the GitHub-style "title #482". Null off GitHub. */
  issueNumber: string | null;
  /** Null unless the source is a GitHub issue on a repository still connected. */
  issueUrl: string | null;
  repositoryFullName: string | null;
  repositoryUrl: string | null;
  reporterHandle: string | null;
  /** The reporter's GitHub profile, and their avatar. Null when the handle is not a login. */
  reporterUrl: string | null;
  reporterAvatarUrl: string | null;
  state: ReportState;
  createdAt: Date;
  updatedAt: Date;
  target: { name: string; imageDigest: string } | null;
  verdict: CaseVerdict | null;
  approval: { decision: string; reviewer: string; note: string | null; decidedAt: Date } | null;
  delivery: { state: string; attempts: number; lastError: string | null; target: string } | null;
  /** The exact verdict a reviewer can answer right now, or null if there is no pending call. */
  awaitingVerdictId: string | null;
  events: CaseEvent[];
};

/**
 * Whether an oracle decided this verdict.
 *
 * Positive evidence only. The old test was the inverse, treating anything that was not the
 * single AUTOMATED_REPRODUCTION_NOT_RUN reason as oracle-decided, so an empty or unrecognised
 * evidence object would have had the page attribute a model-authored outcome to an external
 * canary check. That is the one claim this product must never make on its own.
 *
 * Nothing writes an oracle result yet, so this is false everywhere today, and it starts
 * returning true on its own the day a driver records one.
 */
export function oracleDecided(evidence: unknown): boolean {
  if (typeof evidence !== "object" || evidence === null) return false;
  const oracle = (evidence as { oracle?: unknown }).oracle;
  if (typeof oracle !== "object" || oracle === null) return false;

  return typeof (oracle as { result?: unknown }).result === "string";
}

/**
 * Whether a string could be a report id at all.
 *
 * Checked before the query rather than after: report.id is a uuid column, so a comparison
 * against a malformed string is a Postgres error, and a reviewer following a stale link would
 * get a 500 where a not-found page is the honest answer. Group lengths are pinned, because a
 * pattern that only counts characters accepts thirty-six hyphens.
 */
const REPORT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isReportId(value: string): boolean {
  return REPORT_ID.test(value);
}

/** "github:123456:issue:482" is what intake writes. */
function issueNumber(sourceRef: string): string | null {
  return /^github:\d+:issue:(\d+)$/.exec(sourceRef)?.[1] ?? null;
}

export function caseSourceLabel(sourceRef: string, id: string): string {
  const issue = issueNumber(sourceRef);
  return issue ? `Issue #${issue}` : `#${id.slice(0, 8)}`;
}

/**
 * One report and everything hanging off it, or null if there is no such report.
 *
 * Read inside a read-only repeatable-read transaction for the same reason the board is: a
 * verdict landing between the report read and the event read would render a page describing
 * two different moments.
 */
export async function readCase(id: string): Promise<CaseFile | null> {
  return db.transaction(
    async (tx) => {
      const [row] = await tx
        .select({
          id: report.id,
          title: report.title,
          body: report.body,
          channel: report.channel,
          sourceRef: report.sourceRef,
          reporterHandle: report.reporterHandle,
          state: report.state,
          createdAt: report.createdAt,
          updatedAt: report.updatedAt,
          repositoryFullName: connectedRepository.fullName,
          targetName: targetProfile.name,
          targetDigest: targetProfile.imageDigest,
        })
        .from(report)
        .leftJoin(connectedRepository, eq(report.connectedRepositoryId, connectedRepository.id))
        .leftJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
        .where(eq(report.id, id));

      if (!row) return null;

      // The pending tuple is read before the verdict, because it decides which verdict this
      // page is allowed to show.
      const [session] = await tx
        .select({
          pendingVerdictId: agentSession.pendingVerdictId,
          pendingThreadId: agentSession.pendingThreadId,
        })
        .from(agentSession)
        .where(eq(agentSession.reportId, id));

      // Both halves of the pending tuple are required, the same test app/review/page.tsx
      // makes: a verdict id with no thread is not a call anyone can answer.
      const awaitingVerdictId =
        row.state === "AWAITING_APPROVAL" && session?.pendingThreadId
          ? session.pendingVerdictId
          : null;

      /**
       * The verdict a reviewer is being shown.
       *
       * When a call is pending it is that exact verdict, never the latest one. The gate
       * approves the id in the pending tuple, so showing the newest revision beside an Approve
       * button that binds an older one would let somebody sign text they never read. The two
       * are usually the same row; when a revision lands after the tool call was prepared they
       * are not, and that is exactly when it matters.
       */
      const [latest] = await tx
        .select({
          id: verdict.id,
          outcome: verdict.outcome,
          summary: verdict.summary,
          payload: verdict.payload,
          contentHash: verdict.contentHash,
          revision: verdict.revision,
          evidence: verdict.evidence,
          createdAt: verdict.createdAt,
        })
        .from(verdict)
        .where(awaitingVerdictId ? eq(verdict.id, awaitingVerdictId) : eq(verdict.reportId, id))
        .orderBy(desc(verdict.revision))
        .limit(1);

      const [decision] = latest
        ? await tx
            .select({
              decision: approvalDecision.decision,
              reviewer: approvalDecision.reviewer,
              note: approvalDecision.note,
              decidedAt: approvalDecision.decidedAt,
            })
            .from(approvalDecision)
            .where(eq(approvalDecision.verdictId, latest.id))
        : [];

      // Keyed on the verdict, not the report. A report can carry a delivery per revision, and
      // a report-only predicate returns whichever row the planner reached first, so the page
      // could show revision 2's verdict beside revision 1's delivery and its errors.
      const [dispatch] = latest
        ? await tx
            .select({
              state: outboundDelivery.state,
              attempts: outboundDelivery.attempts,
              lastError: outboundDelivery.lastError,
              target: outboundDelivery.target,
            })
            .from(outboundDelivery)
            .where(eq(outboundDelivery.verdictId, latest.id))
        : [];

      const events = await tx
        .select({
          seq: sessionEvent.seq,
          type: sessionEvent.type,
          data: sessionEvent.data,
          at: sessionEvent.createdAt,
        })
        .from(sessionEvent)
        .where(eq(sessionEvent.reportId, id))
        .orderBy(sessionEvent.seq);

      const issue = issueNumber(row.sourceRef);
      // Only a GitHub report has a GitHub profile behind its handle, and only a handle that
      // could be a login is worth linking: anything else builds a URL to a 404 or, worse, to
      // somebody else's account.
      const login =
        row.channel === "github" && row.reporterHandle && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(row.reporterHandle)
          ? row.reporterHandle
          : null;

      return {
        ...row,
        sourceLabel: caseSourceLabel(row.sourceRef, row.id),
        issueNumber: issue,
        issueUrl:
          issue && row.repositoryFullName
            ? `https://github.com/${row.repositoryFullName}/issues/${issue}`
            : null,
        repositoryUrl: row.repositoryFullName
          ? `https://github.com/${row.repositoryFullName}`
          : null,
        reporterUrl: login ? `https://github.com/${login}` : null,
        reporterAvatarUrl: login ? `https://github.com/${login}.png?size=64` : null,
        target: row.targetName
          ? { name: row.targetName, imageDigest: row.targetDigest ?? "" }
          : null,
        verdict: latest ?? null,
        approval: decision ?? null,
        delivery: dispatch ?? null,
        awaitingVerdictId,
        events: events.map((e) => ({ ...e, channel: e.type.split(".")[0] })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
