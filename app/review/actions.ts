"use server";

import { revalidatePath } from "next/cache";

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
import { deliverById } from "@/lib/delivery/worker";
import { enqueueApprovedVerdictDelivery } from "@/lib/mcp/publish-verdict";
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

function revalidateReportViews(reportId: string) {
  for (const path of ["/board", `/reports/${reportId}`, "/reports", "/home"]) {
    try {
      revalidatePath(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("static generation store missing")) continue;
      console.error(
        `could not revalidate ${path}: ${message}`,
      );
    }
  }
}

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
  let immediateDeliveryId: string | null = null;
  try {
    const result = await db.transaction(async (tx) => {
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
        if (existing.decision !== outcome) {
          return { ok: false, error: "already decided differently" };
        }
        const noHarnessCall = session.pendingThreadId === null && session.pendingToolCallId === null;
        if (
          noHarnessCall &&
          outcome === "APPROVED" &&
          reportRow.state === "ANALYSIS_ONLY" &&
          v.outcome === "ANALYSIS_ONLY" &&
          session.pendingVerdictId === v.id &&
          session.pendingApprovedContentHash &&
          computeContentHash(v.payload) === session.pendingApprovedContentHash
        ) {
          const enqueued = await enqueueApprovedVerdictDelivery(
            tx,
            session.id,
            { id: v.id, reportId: v.reportId, outcome: v.outcome },
            session.pendingApprovedContentHash,
          );
          if (!enqueued.ok) throw new DecisionRefused(enqueued.reason);
          immediateDeliveryId = enqueued.deliveryId;
        }
        return { ok: true };
      }

      const canDecide =
        reportRow.state === "AWAITING_APPROVAL" ||
        (reportRow.state === "ANALYSIS_ONLY" && v.outcome === "ANALYSIS_ONLY");

      // No decision exists yet, so this has to be the fresh path. A stale action call from a
      // page rendered before the report left a reviewable state (cancelled, expired, or
      // already decided and moved on by some other path) must be refused here explicitly:
      // denial gets this for free from transition()'s own CAS below, but approval has no
      // such check downstream, since DELIVERING only ever happens inside publish_verdict or
      // the synthesized-verdict submission path.
      if (!canDecide) {
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
      const noHarnessCall = pending.pendingThreadId === null && pending.pendingToolCallId === null;

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

      if (noHarnessCall && outcome === "APPROVED") {
        const enqueued = await enqueueApprovedVerdictDelivery(
          tx,
          pending.id,
          { id: v.id, reportId: v.reportId, outcome: v.outcome },
          pending.pendingApprovedContentHash,
        );
        if (!enqueued.ok) throw new DecisionRefused(enqueued.reason);
        immediateDeliveryId = enqueued.deliveryId;
      } else if (!noHarnessCall) {
        // Best-effort informational for the submission worker: it tells TrueForge about the
        // decision, but it is not what bounty-desk's own state depends on. Synthesized
        // analysis-only verdicts have no harness call to answer, so approving them goes
        // straight to the outbox above and denying them closes locally below.
        await tx
          .insert(approvalSubmission)
          .values({ agentSessionId: pending.id, approvalDecisionId: decisionId, state: "PENDING" })
          .onConflictDoNothing({ target: approvalSubmission.approvalDecisionId });
      }

      // A denial is final on bounty-desk's side immediately. Harness-backed approvals still
      // move only when TrueForge invokes publish_verdict; synthesized analysis-only approvals
      // have no harness call to answer, so the outbox write above is their publish step.
      if (outcome === "DENIED") {
        try {
          await transition(reportId, reportRow.state, "DENIED", tx);
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
    if (result.ok && immediateDeliveryId) {
      try {
        await deliverById(
          immediateDeliveryId,
          `review-action-delivery-${immediateDeliveryId}`,
          { leaseSeconds: 20 },
        );
      } catch (error) {
        console.error(
          `delivery ${immediateDeliveryId}: immediate post after approval failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    revalidateReportViews(reportId);
    return result;
  } catch (error) {
    if (error instanceof DecisionRefused) return { ok: false, error: error.message };
    throw error;
  }
}

/**
 * Record that a human approved the pending verdict. Harness-backed approvals are queued for
 * the approval-submission worker to relay to TrueForge. Synthesized analysis-only verdicts have
 * no TrueForge call to answer, so the same approval records consent and queues the GitHub
 * delivery directly.
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
