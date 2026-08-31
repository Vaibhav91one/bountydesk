import {
  agentSession,
  and,
  approvalDecision,
  approvalSubmission,
  artifact,
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
import { MAX_ATTEMPTS as HANDOFF_MAX_ATTEMPTS } from "@/lib/approval-submission/queue";
export {
  isAgentInvestigating,
  oracleDecided,
  verdictFindings,
  type CaseArtifact,
  type CaseEvent,
  type CaseFile,
  type CaseVerdict,
} from "@/lib/reports/case-facts";
import type { CaseFile } from "@/lib/reports/case-facts";

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
          pendingApprovedContentHash: agentSession.pendingApprovedContentHash,
          turnStatus: agentSession.turnStatus,
          lastError: agentSession.lastError,
          finalSummary: agentSession.finalSummary,
          sandboxId: agentSession.sandboxId,
          appPort: agentSession.appPort,
        })
        .from(agentSession)
        .where(eq(agentSession.reportId, id));

      // A verdict awaiting approval is gated on the verdict/hash pair, not the thread marker:
      // a synthesized ANALYSIS_ONLY verdict (a dead-end run) has a verdict and hash to approve
      // but no TrueForge call, so its thread/tool-call ids are null. Gating on the thread here
      // would hide it from review and recreate the dead end this whole flow exists to close.
      const pendingVerdictId =
        (row.state === "AWAITING_APPROVAL" || row.state === "ANALYSIS_ONLY") &&
        session?.pendingVerdictId &&
        session?.pendingApprovedContentHash
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
       * A pending id that names no verdict of this report is a broken tuple, so the pending
       * verdict is not shown as answerable. The page still shows the record, read-only, because
       * the report's own verdicts are not in doubt.
       */
      const canShowPending =
        pending &&
        (row.state === "AWAITING_APPROVAL" || pending.outcome === "ANALYSIS_ONLY");

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

      const latest = canShowPending && pending ? pending : newest;

      const [decision] = latest
        ? await tx
            .select({
              id: approvalDecision.id,
              decision: approvalDecision.decision,
              reviewer: approvalDecision.reviewer,
              note: approvalDecision.note,
              decidedAt: approvalDecision.decidedAt,
            })
            .from(approvalDecision)
            .where(eq(approvalDecision.verdictId, latest.id))
        : [];

      const awaitingVerdictId = canShowPending && !decision ? pendingVerdictId : null;

      // Whether the decision ever reached the harness.
      //
      // For a harness-backed verdict this row is the only thing that starts delivery: the
      // submission worker tells TrueForge, TrueForge calls publish_verdict, and only then does
      // an outbound_delivery row exist. So a submission that died leaves a report approved,
      // with no delivery to point at and nothing on its way. Without this read the case file
      // could not tell that apart from a delivery that simply has not started yet.
      //
      // At most one row per decision (approval_submission_approval_decision_key), so there is
      // no newest to pick. Absent entirely for a synthesized verdict, which is enqueued inline
      // by the approval action and never involves the harness.
      const [handoff] = decision
        ? await tx
            .select({
              state: approvalSubmission.state,
              attempts: approvalSubmission.attempts,
              lastError: approvalSubmission.lastError,
            })
            .from(approvalSubmission)
            .where(eq(approvalSubmission.approvalDecisionId, decision.id))
        : [];

      // Keyed on the verdict, not the report. A report can carry a delivery per revision, and
      // a report-only predicate returns whichever row the planner reached first, so the page
      // could show revision 2's verdict beside revision 1's delivery and its errors.
      const [dispatch] = latest
        ? await tx
            .select({
              state: outboundDelivery.state,
              attempts: outboundDelivery.attempts,
              maxAttempts: outboundDelivery.maxAttempts,
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
          eventKey: sessionEvent.eventKey,
          at: sessionEvent.createdAt,
        })
        .from(sessionEvent)
        .where(eq(sessionEvent.reportId, id))
        .orderBy(sessionEvent.seq);

      const artifacts = await tx
        .select({
          id: artifact.id,
          kind: artifact.kind,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
          contentType: artifact.contentType,
          storagePath: artifact.storagePath,
          createdAt: artifact.createdAt,
        })
        .from(artifact)
        .where(eq(artifact.reportId, id))
        .orderBy(desc(artifact.createdAt));

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
        sessionError: session?.lastError ?? null,
        finalSummary: session?.finalSummary ?? null,
        sandbox: session?.sandboxId
          ? { id: session.sandboxId, appPort: session.appPort ?? null }
          : null,
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
        // The retry ceiling is a module constant rather than a column on this table, unlike
        // outbound_delivery. Resolved here so the derived view can compare against it without
        // importing the queue, which would drag the connection pool into a pure module.
        handoff: handoff ? { ...handoff, maxAttempts: HANDOFF_MAX_ATTEMPTS } : null,
        awaitingVerdictId,
        events: events.map((e) => ({ ...e, channel: e.type.split(".")[0] })),
        artifacts: artifacts.map(({ storagePath, ...rest }) => ({
          ...rest,
          stored: storagePath !== null,
        })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
