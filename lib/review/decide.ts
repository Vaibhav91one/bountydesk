import { revalidatePath } from "next/cache";

import {
  agentSession,
  and,
  approvalDecision,
  approvalSubmission,
  db,
  eq,
  report,
  verdict,
  verdictSupersession,
} from "@/lib/db";
import { deliverById } from "@/lib/delivery/worker";
import { enqueueApprovedVerdictDelivery } from "@/lib/mcp/publish-verdict";
import { ReportStateConflictError, transition } from "@/lib/reports/lifecycle";
import { computeContentHash } from "@/lib/verdicts/hash";
import { safeErrorText } from "@/lib/errors/safe-error";

export type ActionResult = { ok: boolean; error?: string };

/**
 * Raised to unwind an in-flight transaction after it has already written a decision or
 * submission row. `db.transaction` commits whatever a callback returns normally, so a plain
 * `return { ok: false }` after those writes would ship them anyway; throwing is what forces
 * the rollback.
 */
class DecisionRefused extends Error {}

/**
 * A dropped-connection failure, the one class worth one retry.
 *
 * The Supabase transaction pooler hands back a socket it has already closed, and the first
 * statement on it fails with a connection error rather than a query error. A fresh connection
 * succeeds, so `decide` retries once. A constraint violation, a lock timeout or any other query
 * error is not this, and is surfaced rather than retried.
 */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
]);

function isTransientConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("connection terminated") ||
    message.includes("connection closed") ||
    message.includes("connection ended") ||
    message.includes("econnreset") ||
    message.includes("write after end") ||
    message.includes("socket")
  );
}

// The dialog appends its own "Nothing was recorded; reload..." line, so this stays short and does
// not repeat it.
export const HASH_MISMATCH = "content hash mismatch; refresh and retry";
export const DECISION_FAILED = "Could not record that decision because the database call failed";

export function revalidateReportViews(reportId: string) {
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
export async function decide(
  reportId: string,
  verdictId: string,
  outcome: "APPROVED" | "DENIED",
  reviewer: string,
  note: string | undefined,
  // A client that cannot render the verdict through this process (the mobile app) sends the hash
  // of the exact text it showed. When given, it has to equal the hash of the text this verdict
  // would deliver, the same rule publish_verdict enforces, or the decision is refused.
  expectedContentHash?: string,
): Promise<ActionResult> {
  let immediateDeliveryId: string | null = null;

  const runOnce = () =>
    db.transaction(async (tx): Promise<ActionResult> => {
      // Reset per attempt: a retried transaction re-enqueues its own delivery, and the id from a
      // rolled-back attempt names a row that no longer exists.
      immediateDeliveryId = null;
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

      // Checked before the replay branch so even a repeat call must name the text it saw.
      if (
        expectedContentHash !== undefined &&
        (expectedContentHash !== computeContentHash(v.payload) || expectedContentHash !== v.contentHash)
      ) {
        return { ok: false, error: HASH_MISMATCH };
      }

      const [existing] = await tx
        .select({ decision: approvalDecision.decision })
        .from(approvalDecision)
        .where(eq(approvalDecision.verdictId, v.id));

      // A verdict superseded by a re-check can never receive a decision: the run that drafted it
      // is over, and approving dead text the reviewer has explicitly moved past would ship a
      // comment the report has already moved on from. Checked before the replay branch so a
      // re-check after an earlier decision of the same outcome is still refused.
      const [supersededRow] = await tx
        .select({ id: verdictSupersession.id })
        .from(verdictSupersession)
        .where(eq(verdictSupersession.oldVerdictId, v.id))
        .limit(1);
      if (supersededRow) {
        return { ok: false, error: "this verdict has been superseded by a re-check" };
      }

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
        return { ok: false, error: HASH_MISMATCH };
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

  // A transient connection error mid-transaction rolls the whole thing back, so a single retry is
  // safe: it either records the decision cleanly or fails again and is surfaced. An unexpected
  // error is turned into a friendly result rather than a raw 500, so the reviewer sees a message
  // in the dialog and can reload, and the report is never left stuck with no explanation.
  let result: ActionResult;
  try {
    result = await runOnce();
  } catch (error) {
    if (error instanceof DecisionRefused) return { ok: false, error: error.message };
    if (isTransientConnectionError(error)) {
      try {
        result = await runOnce();
      } catch (retryError) {
        if (retryError instanceof DecisionRefused) return { ok: false, error: retryError.message };
        console.error(
          `approval decision for report ${reportId} failed after retry: ${safeErrorText(retryError)}`,
        );
        return { ok: false, error: DECISION_FAILED };
      }
    } else {
      console.error(
        `approval decision for report ${reportId} failed: ${safeErrorText(error)}`,
      );
      return { ok: false, error: DECISION_FAILED };
    }
  }

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
}
