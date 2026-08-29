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
  /** Null unless the source is a GitHub issue on a repository still connected. */
  issueUrl: string | null;
  repositoryFullName: string | null;
  reporterHandle: string | null;
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

      // Latest revision. A verdict is revised by inserting the next one, never by editing.
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
        .where(eq(verdict.reportId, id))
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

      const [dispatch] = await tx
        .select({
          state: outboundDelivery.state,
          attempts: outboundDelivery.attempts,
          lastError: outboundDelivery.lastError,
          target: outboundDelivery.target,
        })
        .from(outboundDelivery)
        .where(eq(outboundDelivery.reportId, id));

      // Both halves of the pending tuple are required, the same test app/review/page.tsx
      // makes: a verdict id with no thread is not a call anyone can answer.
      const [session] = await tx
        .select({
          pendingVerdictId: agentSession.pendingVerdictId,
          pendingThreadId: agentSession.pendingThreadId,
        })
        .from(agentSession)
        .where(eq(agentSession.reportId, id));

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

      return {
        ...row,
        sourceLabel: caseSourceLabel(row.sourceRef, row.id),
        issueUrl:
          issue && row.repositoryFullName
            ? `https://github.com/${row.repositoryFullName}/issues/${issue}`
            : null,
        target: row.targetName
          ? { name: row.targetName, imageDigest: row.targetDigest ?? "" }
          : null,
        verdict: latest ?? null,
        approval: decision ?? null,
        delivery: dispatch ?? null,
        awaitingVerdictId:
          row.state === "AWAITING_APPROVAL" && session?.pendingThreadId
            ? session.pendingVerdictId
            : null,
        events: events.map((e) => ({ ...e, channel: e.type.split(".")[0] })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
