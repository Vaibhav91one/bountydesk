import {
  agentSession,
  and,
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
import { findingSchema, type Finding } from "@/lib/mcp/publish-verdict";
import type { ReportState } from "@/lib/reports/states";

/**
 * Everything one report has to show, read in one snapshot.
 *
 * Display only, like queue.ts. The approval gate in app/review/actions.ts re-reads and locks
 * its own rows when a reviewer clicks, so nothing here is a permission: a page that says
 * "awaiting approval" is describing the moment it was rendered.
 *
 * verdict.evidence is jsonb and its shape depends on how the verdict was drafted. The live path
 * writes `{source: "agent-drafted", findings: Finding[]}`, the agent's own claims from its
 * sandboxed investigation. An older row, or a report that never reached a target, may carry
 * something else entirely (a bare reason string, or nothing usable at all). Every reader here
 * is defensive about the shape for exactly that reason.
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
  /** Local agent-session bookkeeping, never a report state (see lib/db/schema.ts on
   * agentSession): RUNNING | INVESTIGATING | AWAITING_APPROVAL_HARNESS | DONE_NO_ACTION |
   * ERROR | CANCELLED. Null when no session exists yet for this report. */
  turnStatus: string | null;
  target: { name: string; imageDigest: string } | null;
  verdict: CaseVerdict | null;
  approval: { decision: string; reviewer: string; note: string | null; decidedAt: Date } | null;
  delivery: { state: string; attempts: number; lastError: string | null; target: string } | null;
  /** The exact verdict a reviewer can answer right now, or null if there is no pending call. */
  awaitingVerdictId: string | null;
  events: CaseEvent[];
};

/**
 * Whether the agent is actively working this report right now.
 *
 * Requires all three: its harness turn is live (`RUNNING` or `INVESTIGATING`), it has at least
 * one mirrored `agent.tool_call:*` event (lib/agent-sessions/poller.ts), and no verdict has
 * been drafted yet. The live path mints a verdict only once the agent calls `publish_verdict`,
 * the last thing it does in its turn (see lib/mcp/publish-verdict.ts), so a verdict already
 * existing means whatever the turn status still says is stale or about to be.
 *
 * The tool-call requirement is deliberate, not incidental: a turn sits in `RUNNING` from the
 * instant the driver calls `createTurn`, before the agent has done anything at all, and a
 * report claiming to be "under investigation" with zero observed activity would be a stronger
 * claim than the evidence supports -- the same fail-closed standard `oracleDecided` and
 * `verdictFindings` already hold this page to. This is also the single definition the board
 * badge, the case-file badge, and the case-file's "Investigation" lifecycle step all read, so
 * the three surfaces can never disagree with each other about whether a run is live.
 */
export function isAgentInvestigating(
  turnStatus: string | null,
  hasVerdict: boolean,
  hasToolCallEvents: boolean,
): boolean {
  return !hasVerdict && hasToolCallEvents && (turnStatus === "RUNNING" || turnStatus === "INVESTIGATING");
}

/**
 * Whether a canary oracle, not just the agent's own reasoning, decided this verdict.
 *
 * True only for evidence that positively records one: an `oracle` object carrying a string
 * `result`. The agent's own drafted investigation is the primary and permanent source of a
 * verdict today (see docs/decisions.md Q22); the canary/fixture/negative-control pipeline in
 * lib/sandbox/reproduce.ts is retained as a strictly stronger, optional evidence source, not
 * yet wired into the live path. Anything else, including an empty or unrecognised evidence
 * object, means this verdict is the agent's own conclusion, and saying otherwise would attribute
 * it to a check that never ran.
 */
export function oracleDecided(evidence: unknown): boolean {
  if (typeof evidence !== "object" || evidence === null) return false;
  const oracle = (evidence as { oracle?: unknown }).oracle;
  if (typeof oracle !== "object" || oracle === null) return false;

  return typeof (oracle as { result?: unknown }).result === "string";
}

/**
 * The agent's own drafted findings off a verdict's evidence, if it recorded any.
 *
 * Defensive about the shape because evidence is jsonb and pre-redesign rows, or a report that
 * never reached a target, may carry something else entirely. Reuses the same `findingSchema`
 * `publish_verdict` validates a draft against, so a finding renders here exactly if it would
 * have been accepted there.
 */
export function verdictFindings(evidence: unknown): Finding[] {
  if (typeof evidence !== "object" || evidence === null) return [];
  const value = (evidence as { source?: unknown; findings?: unknown }).findings;
  if ((evidence as { source?: unknown }).source !== "agent-drafted" || !Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const parsed = findingSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Whether a string could be a report id at all.
 *
 * Checked before the query rather than after: report.id is a uuid column, so a comparison
 * against a malformed string is a Postgres error, and a reviewer following a stale link would
 * get a 500 where a not-found page is the honest answer. Group lengths are pinned rather than
 * counted, because a total-length check accepts thirty-six hyphens.
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
          turnStatus: agentSession.turnStatus,
        })
        .from(agentSession)
        .where(eq(agentSession.reportId, id));

      // Both halves of the pending tuple are required, the same test app/review/page.tsx
      // makes: a verdict id with no thread is not a call anyone can answer.
      const pendingVerdictId =
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
       *
       * The report predicate stays on either branch. verdict.id and agent_session.report_id are
       * independent foreign keys, so a session naming a verdict that belongs to a different
       * report would otherwise render that report's payload, hash, approval and delivery here.
       */
      const [pending] = pendingVerdictId
        ? await tx
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
            .where(and(eq(verdict.id, pendingVerdictId), eq(verdict.reportId, id)))
        : [];

      /**
       * A pending id that names no verdict of this report is a broken tuple, so nothing is
       * awaiting a decision here. The page still shows the record, read-only, because the
       * report's own verdicts are not in doubt; what is in doubt is the call, and offering an
       * Approve button for one nobody can identify is the failure worth closing off.
       */
      const awaitingVerdictId = pending ? pendingVerdictId : null;

      const [newest] = await tx
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

      const latest = pending ?? newest;

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
        turnStatus: session?.turnStatus ?? null,
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
