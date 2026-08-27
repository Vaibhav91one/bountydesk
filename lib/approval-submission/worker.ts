import { agentSession, approvalDecision, db, eq } from "@/lib/db";
import { createTrueForgeClient, type TrueForgeClient, type TurnInput } from "@/lib/trueforge/client";

import { claim, fail, LeaseLostError, markSubmitted, type ApprovalSubmissionLease } from "./queue";

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
        threadId: approvalDecision.threadId,
        toolCallId: approvalDecision.toolCallId,
        decision: approvalDecision.decision,
        note: approvalDecision.note,
      })
      .from(approvalDecision)
      .where(eq(approvalDecision.id, lease.approvalDecisionId));

    if (!decision) {
      throw new Error(`approval decision ${lease.approvalDecisionId} does not exist`);
    }

    const [session] = await db
      .select({ sessionId: agentSession.sessionId })
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
      const result = await client.createTurn(session.sessionId, [input]);
      await markSubmitted(lease, result.turnId);
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
