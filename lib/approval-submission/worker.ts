import { agentSession, and, approvalDecision, db, eq, verdict } from "@/lib/db";
import { computeContentHash } from "@/lib/verdicts/hash";
import { createTrueForgeClient, type TrueForgeClient, type TurnInput } from "@/lib/trueforge/client";

import {
  claim,
  fail,
  failPermanently,
  LeaseLostError,
  markSubmitted,
  releaseUnstarted,
  renew,
  type ApprovalSubmissionLease,
} from "./queue";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runWithHeartbeat<T>(
  lease: ApprovalSubmissionLease,
  leaseSeconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = outerSignal
    ? AbortSignal.any([controller.signal, outerSignal])
    : controller.signal;
  const intervalMs = Math.max(50, Math.floor((leaseSeconds * 1000) / 3));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal = Promise.resolve();
  let rejectLeaseLoss!: (reason: unknown) => void;
  const leaseLoss = new Promise<never>((_, reject) => {
    rejectLeaseLoss = reject;
  });
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  const heartbeat = () => {
    renewal = renew(lease, leaseSeconds)
      .then(() => {
        if (!stopped) timer = setTimeout(heartbeat, intervalMs);
      })
      .catch((error: unknown) => {
        controller.abort(error);
        rejectLeaseLoss(error);
      });
  };

  timer = setTimeout(heartbeat, intervalMs);
  try {
    const result = await Promise.race([operation(signal), leaseLoss, aborted]);
    if (signal.aborted) throw signal.reason;
    return result;
  } finally {
    stopped = true;
    signal.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
    await renewal.catch(() => undefined);
  }
}

/**
 * Tell TrueForge about one already-recorded decision, and record whether it landed.
 *
 * Returns the claimed row's id once something was done with it (submitted or failed), or
 * null when nothing was claimable.
 */
export async function submitApprovalOnce(
  owner: string,
  opts: { leaseSeconds?: number; client?: TrueForgeClient; signal?: AbortSignal } = {},
): Promise<string | null> {
  if (opts.signal?.aborted) return null;
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
      await failPermanently(
        lease,
        `approval decision ${lease.approvalDecisionId} does not exist`,
      );
      return lease.id;
    }

    const [session] = await db
      .select({
        reportId: agentSession.reportId,
        sessionId: agentSession.sessionId,
        turnId: agentSession.turnId,
        pendingThreadId: agentSession.pendingThreadId,
        pendingToolCallId: agentSession.pendingToolCallId,
        pendingVerdictId: agentSession.pendingVerdictId,
        pendingApprovedContentHash: agentSession.pendingApprovedContentHash,
      })
      .from(agentSession)
      .where(eq(agentSession.id, lease.agentSessionId));

    if (!session) {
      await failPermanently(lease, `agent session ${lease.agentSessionId} does not exist`);
      return lease.id;
    }

    // threadId/toolCallId are non-null by the time a submission exists in practice (the
    // reviewer UI only creates one once it has real pending markers to bind to), but this is
    // a trust boundary between two independently-shipped features, so it is checked here
    // rather than assumed.
    if (!decision.threadId || !decision.toolCallId) {
      await failPermanently(
        lease,
        `approval decision ${lease.approvalDecisionId} has no pending call to answer (threadId/toolCallId missing)`,
      );
      return lease.id;
    }
    const threadId = decision.threadId;
    const toolCallId = decision.toolCallId;

    // approval_submission.agent_session_id and .approval_decision_id are independent foreign
    // keys, so nothing in the schema stops a submission from pairing a decision with a
    // session for a different report. Load the decision's own verdict and check it against
    // the session's report before this worker ever tells TrueForge anything.
    const [verdictRow] = await db
      .select({ reportId: verdict.reportId, payload: verdict.payload })
      .from(verdict)
      .where(eq(verdict.id, decision.verdictId));

    if (!verdictRow) {
      await failPermanently(lease, `verdict ${decision.verdictId} does not exist`);
      return lease.id;
    }
    if (verdictRow.reportId !== session.reportId) {
      await failPermanently(
        lease,
        `approval decision ${lease.approvalDecisionId} is for report ${verdictRow.reportId}, ` +
          `but agent session ${lease.agentSessionId} belongs to report ${session.reportId}`,
      );
      return lease.id;
    }

    // Both choices answer the exact payload the reviewer saw. Refuse a stale commitment before
    // TrueForge receives either decision; a retry cannot repair an immutable verdict or decision.
    if (computeContentHash(verdictRow.payload) !== decision.payloadHash) {
      await failPermanently(
        lease,
        `verdict ${decision.verdictId} content hash no longer matches the approved decision`,
      );
      return lease.id;
    }

    if (
      session.pendingThreadId !== threadId ||
      session.pendingToolCallId !== toolCallId ||
      session.pendingVerdictId !== decision.verdictId ||
      session.pendingApprovedContentHash !== decision.payloadHash
    ) {
      await failPermanently(
        lease,
        `approval decision ${lease.approvalDecisionId} does not match the session's pending approval`,
      );
      return lease.id;
    }
    if (!session.turnId) {
      await failPermanently(
        lease,
        `agent session ${lease.agentSessionId} has no turn awaiting this approval`,
      );
      return lease.id;
    }
    const currentTurnId = session.turnId;

    const input: TurnInput = {
      type: "user.tool_approval",
      threadId,
      toolCallId,
      approval:
        decision.decision === "APPROVED"
          ? { status: "allow" }
          : { status: "deny", ...(decision.note ? { reason: decision.note } : {}) },
    };

    const client = opts.client ?? createTrueForgeClient();

    try {
      await renew(lease, leaseSeconds);
      const result = await runWithHeartbeat(
        lease,
        leaseSeconds,
        async (signal) => {
          const existing = await client.findTurnByInput?.(session.sessionId, [input], { signal });
          return existing ?? client.createTurn(session.sessionId, [input], { signal });
        },
        opts.signal,
      );
      await db.transaction(async (tx) => {
        await markSubmitted(lease, result.turnId, tx);
        // The old pending call this decision answered is now resolved; hand the session off
        // to the new chained turn TrueForge just created so the poller follows it instead of
        // re-discovering the same, now-answered pending call forever. Without this the
        // poller keeps polling the original turnId, sees the identical still-pending
        // publish_verdict call, and loops indefinitely rather than ever finding out how the
        // new turn (where the harness actually acts on the decision) turns out.
        const updatedSession = await tx
          .update(agentSession)
          .set({
            turnId: result.turnId,
            turnStatus: "RUNNING",
            ...(decision.decision === "DENIED"
              ? {
                  pendingThreadId: null,
                  pendingToolCallId: null,
                  pendingVerdictId: null,
                  pendingApprovedContentHash: null,
                }
              : {}),
            nextPollAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agentSession.id, lease.agentSessionId),
              eq(agentSession.turnId, currentTurnId),
              eq(agentSession.pendingThreadId, threadId),
              eq(agentSession.pendingToolCallId, toolCallId),
              eq(agentSession.pendingVerdictId, decision.verdictId),
              eq(agentSession.pendingApprovedContentHash, decision.payloadHash),
            ),
          )
          .returning({ id: agentSession.id });

        if (updatedSession.length === 0) {
          throw new Error(
            `agent session ${lease.agentSessionId} changed while its approval was being submitted`,
          );
        }
      });
    } catch (err) {
      if (err instanceof LeaseLostError) return lease.id;
      if (opts.signal?.aborted) {
        try {
          await releaseUnstarted(lease);
        } catch (releaseError) {
          if (!(releaseError instanceof LeaseLostError)) throw releaseError;
        }
        return lease.id;
      }
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
