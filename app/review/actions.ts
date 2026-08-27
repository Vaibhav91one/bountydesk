"use server";

import { desc } from "drizzle-orm";

import { requireReviewer } from "@/lib/auth/dal";
import {
  agentSession,
  approvalDecision,
  approvalSubmission,
  db,
  eq,
  verdict,
  type Executor,
} from "@/lib/db";
import { ReportStateConflictError, transition } from "@/lib/reports/lifecycle";
import { computeContentHash } from "@/lib/verdicts/hash";

export type ActionResult = { ok: boolean; error?: string };

/**
 * Raised to unwind an in-flight transaction after it has already written a decision or
 * submission row. `db.transaction` commits whatever a callback returns normally, so a plain
 * `return { ok: false }` after those writes would ship them anyway; throwing is what forces
 * the rollback.
 */
class DecisionRefused extends Error {}

type PendingCall = Pick<
  typeof agentSession.$inferSelect,
  "id" | "pendingThreadId" | "pendingToolCallId" | "pendingVerdictId" | "pendingApprovedContentHash"
>;

/**
 * The verdict a decision answers.
 *
 * Normally that is the one named by agent_session.pending_verdict_id. But this function also
 * has to serve a second call for the exact same report after the first one already cleared
 * those columns (a double submit, a browser retry): there the pending row has nothing left
 * to point at, so the report's latest verdict is looked up directly. Whether that replay is
 * accepted comes down to what recordDecision finds already sitting on it, not this lookup.
 */
async function verdictToDecide(tx: Executor, reportId: string, pendingVerdictId: string | null) {
  if (pendingVerdictId) {
    const [row] = await tx.select().from(verdict).where(eq(verdict.id, pendingVerdictId));
    return row ?? null;
  }

  const [row] = await tx
    .select()
    .from(verdict)
    .where(eq(verdict.reportId, reportId))
    .orderBy(desc(verdict.revision))
    .limit(1);
  return row ?? null;
}

/**
 * The shared body of allowVerdict and denyVerdict: load and lock the session, resolve the
 * verdict it answers, and decide whether this call is a fresh decision, a no-op replay of one
 * already recorded, or a refusal.
 */
async function decide(
  reportId: string,
  outcome: "APPROVED" | "DENIED",
  reviewer: string,
  note: string | undefined,
): Promise<ActionResult> {
  try {
    return await db.transaction(async (tx) => {
      // Locks the row so a genuinely concurrent double-click serializes here rather than
      // both racing the insert below: the second call blocks until the first's transaction
      // commits, then sees its cleared pending columns and its already-recorded decision.
      const [session] = await tx
        .select()
        .from(agentSession)
        .where(eq(agentSession.reportId, reportId))
        .for("update");

      if (!session) return { ok: false, error: "no pending approval for this report" };

      const pending: PendingCall = session;
      const v = await verdictToDecide(tx, reportId, pending.pendingVerdictId);
      if (!v) return { ok: false, error: "no pending approval for this report" };

      const [existing] = await tx
        .select({ decision: approvalDecision.decision })
        .from(approvalDecision)
        .where(eq(approvalDecision.verdictId, v.id));

      if (existing) {
        // Idempotent replay: the report was already decided (by this call landing twice, or
        // by the pending columns having been cleared for it already). Matching the earlier
        // outcome is a no-op success; disagreeing is refused rather than silently ignored.
        return existing.decision === outcome
          ? { ok: true }
          : { ok: false, error: "already decided differently" };
      }

      // No decision exists yet, so this has to be the fresh path, which needs an actual
      // pending call to answer, bound to this exact verdict.
      if (
        !pending.pendingThreadId ||
        !pending.pendingToolCallId ||
        !pending.pendingVerdictId ||
        !pending.pendingApprovedContentHash ||
        pending.pendingVerdictId !== v.id
      ) {
        return { ok: false, error: "no pending approval for this report" };
      }

      // Defense in depth: never act on a stored hash without recomputing it from the exact
      // bytes right before using it. This should never actually differ.
      if (computeContentHash(v.payload) !== pending.pendingApprovedContentHash) {
        return { ok: false, error: "content hash mismatch; refresh and retry" };
      }

      const [inserted] = await tx
        .insert(approvalDecision)
        .values({
          verdictId: v.id,
          reviewer,
          decision: outcome,
          payloadHash: v.contentHash,
          threadId: pending.pendingThreadId,
          toolCallId: pending.pendingToolCallId,
          note: note ?? null,
        })
        .onConflictDoNothing({ target: approvalDecision.verdictId })
        .returning({ id: approvalDecision.id });

      let decisionId = inserted?.id;
      if (!decisionId) {
        // Lost the race despite the row lock above (another decision landed between our
        // select and our insert). Re-read and accept an exact match as success, same as the
        // idempotent-replay check earlier; anything else is a genuine conflict.
        const [raced] = await tx
          .select({
            id: approvalDecision.id,
            decision: approvalDecision.decision,
            threadId: approvalDecision.threadId,
            toolCallId: approvalDecision.toolCallId,
          })
          .from(approvalDecision)
          .where(eq(approvalDecision.verdictId, v.id));

        if (
          !raced ||
          raced.decision !== outcome ||
          raced.threadId !== pending.pendingThreadId ||
          raced.toolCallId !== pending.pendingToolCallId
        ) {
          return { ok: false, error: "already decided differently" };
        }
        decisionId = raced.id;
      }

      // Best-effort informational for the submission worker: it tells TrueForge about the
      // decision, but it is not what bounty-desk's own state depends on.
      await tx
        .insert(approvalSubmission)
        .values({ agentSessionId: pending.id, approvalDecisionId: decisionId, state: "PENDING" })
        .onConflictDoNothing({ target: approvalSubmission.approvalDecisionId });

      // A denial is final on bounty-desk's side immediately. An approval is not: DELIVERING
      // only happens inside the real publish_verdict tool handler, once TrueForge actually
      // invokes it, so nothing here moves the report on the approve path.
      if (outcome === "DENIED") {
        try {
          await transition(reportId, "AWAITING_APPROVAL", "DENIED", tx);
        } catch (error) {
          if (error instanceof ReportStateConflictError) throw new DecisionRefused(error.message);
          throw error;
        }
      }

      // The pending call has been decided from bounty-desk's side. TrueForge itself does not
      // know yet; that is what the approval_submission row queued above is for.
      await tx
        .update(agentSession)
        .set({
          pendingThreadId: null,
          pendingToolCallId: null,
          pendingVerdictId: null,
          pendingApprovedContentHash: null,
        })
        .where(eq(agentSession.id, pending.id));

      return { ok: true };
    });
  } catch (error) {
    if (error instanceof DecisionRefused) return { ok: false, error: error.message };
    throw error;
  }
}

/**
 * Record that a human approved the pending verdict. This never talks to TrueForge and never
 * moves the report to DELIVERING itself: it only records the decision and queues it for the
 * approval-submission worker to relay. The actual delivery transition happens only inside the
 * real publish_verdict tool handler, once TrueForge genuinely invokes it.
 */
export async function allowVerdict(reportId: string): Promise<ActionResult> {
  const session = await requireReviewer();
  return decide(reportId, "APPROVED", session.login, undefined);
}

/**
 * Record that a human denied the pending verdict. Unlike allowVerdict, a denial is final on
 * bounty-desk's side right away, so this transitions the report to DENIED directly rather than
 * waiting on anything TrueForge-side.
 */
export async function denyVerdict(reportId: string, note?: string): Promise<ActionResult> {
  const session = await requireReviewer();
  return decide(reportId, "DENIED", session.login, note);
}
