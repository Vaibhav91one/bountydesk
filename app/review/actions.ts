"use server";

import { requireReviewer } from "@/lib/auth/dal";
import {
  agentSession,
  and,
  approvalDecision,
  approvalSubmission,
  db,
  eq,
  report,
  verdict,
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

/**
 * The shared body of allowVerdict and denyVerdict: load and lock the report and session,
 * bind to the exact verdict the reviewer was shown, and decide whether this call is a fresh
 * decision, a no-op replay of one already recorded, or a refusal.
 *
 * `verdictId` is not optional: the review page always renders one specific verdict, and the
 * action always answers that exact one, never "whatever happens to be pending right now."
 * Without pinning it, a verdict that changed between page render and the reviewer's click
 * (a new pending call replacing the one shown) could be approved without the reviewer ever
 * having seen it.
 */
async function decide(
  reportId: string,
  verdictId: string,
  outcome: "APPROVED" | "DENIED",
  reviewer: string,
  note: string | undefined,
): Promise<ActionResult> {
  try {
    return await db.transaction(async (tx) => {
      const [reportRow] = await tx
        .select({ state: report.state })
        .from(report)
        .where(eq(report.id, reportId))
        .for("update");

      if (!reportRow) return { ok: false, error: "report not found" };

      // Locks the row so a genuinely concurrent double-click serializes here rather than
      // both racing the insert below: the second call blocks until the first's transaction
      // commits, then sees its cleared pending columns and its already-recorded decision.
      const [session] = await tx
        .select()
        .from(agentSession)
        .where(eq(agentSession.reportId, reportId))
        .for("update");

      if (!session) return { ok: false, error: "no pending approval for this report" };

      // Bound by both id and report_id: agent_session.report_id and pending_verdict_id are
      // independent foreign keys, and the schema does not by itself guarantee they agree.
      const [v] = await tx
        .select()
        .from(verdict)
        .where(and(eq(verdict.id, verdictId), eq(verdict.reportId, reportId)));

      if (!v) return { ok: false, error: "verdict not found for this report" };

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

      // No decision exists yet, so this has to be the fresh path. A stale action call from a
      // page rendered before the report left AWAITING_APPROVAL (cancelled, expired, or
      // already decided and moved on by some other path) must be refused here explicitly:
      // denial gets this for free from transition()'s own CAS below, but approval has no
      // such check downstream, since DELIVERING only ever happens inside publish_verdict.
      if (reportRow.state !== "AWAITING_APPROVAL") {
        return {
          ok: false,
          error: `report is no longer awaiting approval (state: ${reportRow.state})`,
        };
      }

      // The fresh path needs a pending verdict bound to this exact one: if the session's
      // pending_verdict_id has moved on to a different verdict since the page rendered, this is
      // not the verdict being answered. The thread/tool-call markers are deliberately not
      // required here: a synthesized ANALYSIS_ONLY verdict has a verdict awaiting approval but
      // no TrueForge call to answer, so they are legitimately null and the decision records
      // them as null (which the approval-submission worker reads as "deliver without a harness
      // round-trip").
      if (
        !session.pendingVerdictId ||
        !session.pendingApprovedContentHash ||
        session.pendingVerdictId !== v.id
      ) {
        return { ok: false, error: "no pending approval for this report" };
      }
      const pending = session;

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

      // Keep the exact pending tuple until the submission worker has handed this decision to
      // TrueForge. An approved call needs the same tuple again when publish_verdict executes;
      // clearing it here would make the approved tool call refuse itself.

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
 *
 * `verdictId` must be the exact id the review page rendered, not resolved fresh here: the
 * reviewer approves what they saw, not whatever happens to be pending at click time.
 */
export async function allowVerdict(reportId: string, verdictId: string): Promise<ActionResult> {
  const session = await requireReviewer();
  return decide(reportId, verdictId, "APPROVED", session.login, undefined);
}

/**
 * Record that a human denied the pending verdict. Unlike allowVerdict, a denial is final on
 * bounty-desk's side right away, so this transitions the report to DENIED directly rather than
 * waiting on anything TrueForge-side.
 */
export async function denyVerdict(
  reportId: string,
  verdictId: string,
  note?: string,
): Promise<ActionResult> {
  const session = await requireReviewer();
  return decide(reportId, verdictId, "DENIED", session.login, note);
}
