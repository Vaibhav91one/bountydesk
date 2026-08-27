import { agentSession, approvalDecision, db, eq, verdict } from "@/lib/db";
import { computeContentHash } from "@/lib/verdicts/hash";
import { createTrueForgeClient, type TrueForgeClient, type TurnInput } from "@/lib/trueforge/client";

import { claim, fail, LeaseLostError, markSubmitted, renew, type ApprovalSubmissionLease } from "./queue";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tell TrueForge about one already-recorded decision, and record whether it landed.
 *
 * Returns the claimed row's id once something was done with it (submitted or failed), or
 * null when nothing was claimable.
 */
export async function submitApprovalOnce(
  owner: string,
  opts: { leaseSeconds?: number; client?: TrueForgeClient } = {},
): Promise<string | null> {
  const leaseSeconds = opts.leaseSeconds ?? 60;
  const lease = await claim(owner, leaseSeconds);
  if (!lease) return null;

  try {
    // Both rows are guaranteed by the schema's FK constraints (approval_decision cannot be
    // deleted at all, per AGENTS.md; agent_session is ON DELETE RESTRICT while a submission
    // references it), so a missing row here is a bug worth surfacing loudly rather than a
    // retryable condition.
    const [decision] = await db
      .select({
        verdictId: approvalDecision.verdictId,
        threadId: approvalDecision.threadId,
        toolCallId: approvalDecision.toolCallId,
        decision: approvalDecision.decision,
        payloadHash: approvalDecision.payloadHash,
        note: approvalDecision.note,
      })
      .from(approvalDecision)
      .where(eq(approvalDecision.id, lease.approvalDecisionId));

    if (!decision) {
      throw new Error(`approval decision ${lease.approvalDecisionId} does not exist`);
    }

    const [session] = await db
      .select({ reportId: agentSession.reportId, sessionId: agentSession.sessionId })
      .from(agentSession)
      .where(eq(agentSession.id, lease.agentSessionId));

    if (!session) {
      throw new Error(`agent session ${lease.agentSessionId} does not exist`);
    }

    // threadId/toolCallId are non-null by the time a submission exists in practice (the
    // reviewer UI only creates one once it has real pending markers to bind to), but this is
    // a trust boundary between two independently-shipped features, so it is checked here
    // rather than assumed.
    if (!decision.threadId || !decision.toolCallId) {
      await fail(
        lease,
        `approval decision ${lease.approvalDecisionId} has no pending call to answer (threadId/toolCallId missing)`,
      );
      return lease.id;
    }

    // approval_submission.agent_session_id and .approval_decision_id are independent foreign
    // keys, so nothing in the schema stops a submission from pairing a decision with a
    // session for a different report. Load the decision's own verdict and check it against
    // the session's report before this worker ever tells TrueForge anything.
    const [verdictRow] = await db
      .select({ reportId: verdict.reportId, payload: verdict.payload })
      .from(verdict)
      .where(eq(verdict.id, decision.verdictId));

    if (!verdictRow) {
      throw new Error(`verdict ${decision.verdictId} does not exist`);
    }
    if (verdictRow.reportId !== session.reportId) {
      throw new Error(
        `approval decision ${lease.approvalDecisionId} is for report ${verdictRow.reportId}, ` +
          `but agent session ${lease.agentSessionId} belongs to report ${session.reportId}`,
      );
    }

    // Submitting "allow" for a verdict whose stored content no longer matches what was
    // approved would just have publish_verdict's own hash check refuse it downstream, after
    // TrueForge has already unblocked the model to call it. Refuse it here instead, before
    // telling TrueForge anything, for the APPROVED case where it matters (a denial carries no
    // content commitment to verify).
    if (decision.decision === "APPROVED" && computeContentHash(verdictRow.payload) !== decision.payloadHash) {
      await fail(
        lease,
        `verdict ${decision.verdictId} content hash no longer matches the approved decision`,
      );
      return lease.id;
    }

    const input: TurnInput = {
      type: "user.tool_approval",
      threadId: decision.threadId,
      toolCallId: decision.toolCallId,
      approval:
        decision.decision === "APPROVED"
          ? { status: "allow" }
          : { status: "deny", ...(decision.note ? { reason: decision.note } : {}) },
    };

    const client = opts.client ?? createTrueForgeClient();

    try {
      // Push the lease's expiry back out to a full window immediately before the external
      // call, rather than holding a heartbeat open for it: TrueForge is loopback and this is
      // a single request, so one renewal ahead of time closes most of the "lease expires
      // mid-call" window cheaply, without the machinery a genuine heartbeat would need.
      await renew(lease, leaseSeconds);
      const result = await client.createTurn(session.sessionId, [input]);
      await db.transaction(async (tx) => {
        await markSubmitted(lease, result.turnId, tx);
        // The old pending call this decision answered is now resolved; hand the session off
        // to the new chained turn TrueForge just created so the poller follows it instead of
        // re-discovering the same, now-answered pending call forever. Without this the
        // poller keeps polling the original turnId, sees the identical still-pending
        // publish_verdict call, and loops indefinitely rather than ever finding out how the
        // new turn (where the harness actually acts on the decision) turns out.
        await tx
          .update(agentSession)
          .set({
            turnId: result.turnId,
            turnStatus: "RUNNING",
            pendingThreadId: null,
            pendingToolCallId: null,
            pendingVerdictId: null,
            pendingApprovedContentHash: null,
            nextPollAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentSession.id, lease.agentSessionId));
      });
    } catch (err) {
      if (err instanceof LeaseLostError) return lease.id;
      await fail(lease, errorMessage(err));
    }

    return lease.id;
  } catch (err) {
    if (err instanceof LeaseLostError) return lease.id;
    // Something failed before the row could even be evaluated (a missing FK target, an
    // unexpected read error). Still record it against the lease rather than leaving the row
    // silently stuck, unless the lease itself is what's gone.
    try {
      await fail(lease, errorMessage(err));
    } catch (recoveryError) {
      if (!(recoveryError instanceof LeaseLostError)) throw recoveryError;
    }
    return lease.id;
  }
}

export type { ApprovalSubmissionLease };
