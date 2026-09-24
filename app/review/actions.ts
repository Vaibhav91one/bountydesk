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
  verdictSupersession,
} from "@/lib/db";
import { deliverById } from "@/lib/delivery/worker";
import { requestOwnerAdvisory } from "@/lib/delivery/advisory";
import { enqueueApprovedVerdictDelivery } from "@/lib/mcp/publish-verdict";
import {
  cancelRecheck,
  requestRecheck,
  retryRecheck,
} from "@/lib/investigation-runs/recheck";
import {
  composeRecheckGuidance,
  MAX_RECHECK_NOTE_LENGTH,
} from "@/lib/investigation-runs/recheck-guidance";
import { ReportStateConflictError, transition } from "@/lib/reports/lifecycle";
import { isReportId } from "@/lib/reports/case";
import { resolveReportId } from "@/app/(app)/reports/[id]/resolve-id";
import { bindTarget } from "@/lib/targets/bind";
import { RUN_NOT_FOUND, thrownActionError } from "@/lib/review/action-errors";
import { computeContentHash } from "@/lib/verdicts/hash";
import { safeErrorText } from "@/lib/errors/safe-error";
import {
  markDuplicateAtGate,
  rejectAtGate,
  releaseForAnalysis,
  type GateResult,
} from "@/lib/triage/gate";

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
const DECISION_FAILED = "Could not record that decision because the database call failed";

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

/**
 * Supersede the pending verdict and open a fresh REVIEWER_GUIDANCE investigation run. The
 * browser sends only an optional note, the server owns the default instruction and composes
 * the final guidance so a request cannot replace the default with its own text. The guidance
 * never edits the old verdict (that row stays immutable history), never approves anything,
 * and never selects a target or tool. The fresh run drafts its own new verdict revision,
 * which needs its own human approval.
 */
export async function requestRecheckAction(
  reportId: string,
  verdictId: string,
  note?: string,
): Promise<ActionResult> {
  const session = await requireReviewer();
  // A server action is callable with any JSON, so the type is checked here, not just the length.
  if (note !== undefined && typeof note !== "string") {
    return { ok: false, error: "The note is not valid." };
  }
  if (note !== undefined && note.length > MAX_RECHECK_NOTE_LENGTH) {
    return { ok: false, error: "The note is too long." };
  }
  const guidance = composeRecheckGuidance(note);
  const result = await requestRecheck(reportId, verdictId, guidance, session.login);
  revalidateReportViews(reportId);
  return result.ok ? { ok: true } : { ok: false, error: result.reason };
}

/**
 * Bind a reproduction target to a report that arrived without one.
 *
 * Email and upload reports have no connected repository to inherit a target from, so they land
 * with none and can only ever be ANALYSIS_ONLY. This is how a human gives one a target, and it
 * is the only way: the profile is chosen from the server's own rows, never from anything the
 * reporter wrote. The verdict gate in publish-verdict.ts is unchanged; this satisfies it rather
 * than weakening it.
 */
export async function bindTargetAction(
  reportId: string,
  profileId: string,
): Promise<ActionResult> {
  const session = await requireReviewer();
  if (!isReportId(reportId) || !isReportId(profileId)) {
    return { ok: false, error: "That report or target is not valid." };
  }
  try {
    const result = await bindTarget(reportId, profileId, session.login);
    if (!result.ok) return { ok: false, error: result.reason };
    revalidateReportViews(reportId);
    return { ok: true };
  } catch (error) {
    return thrownActionError(error, "bind");
  }
}

/**
 * Ask the Zerops worker to open a private draft advisory on the report's repository.
 *
 * Records the request only. The worker holds the App key, re-checks the grant and the approved
 * hash when it sends, and never sends anything but the verdict the reporter already received.
 */
export async function requestOwnerAdvisoryAction(reportId: string): Promise<ActionResult> {
  const session = await requireReviewer();
  if (!isReportId(reportId)) return { ok: false, error: "That report is not valid." };
  try {
    const result = await requestOwnerAdvisory(reportId, session.login);
    if (!result.ok) return { ok: false, error: result.reason };
    revalidateReportViews(reportId);
    return { ok: true };
  } catch (error) {
    return thrownActionError(error, "notify");
  }
}

/** Run one gate decision, turning a thrown failure into a message that leaks nothing. */
async function gateDecision(
  reportId: string,
  decide: () => Promise<GateResult>,
): Promise<ActionResult> {
  if (!isReportId(reportId)) return { ok: false, error: "That report is not valid." };
  try {
    const result = await decide();
    revalidateReportViews(reportId);
    return result.ok ? { ok: true } : { ok: false, error: result.reason };
  } catch (error) {
    console.error(`gate decision on report ${reportId} failed: ${safeErrorText(error)}`);
    return { ok: false, error: "Could not record that decision." };
  }
}

/**
 * Reject an outside report at the NEEDS_DECISION gate, or mark it as spam. The report closes as
 * DENIED and the reporter is sent nothing.
 */
export async function rejectAtGateAction(reportId: string, spam: boolean): Promise<ActionResult> {
  const session = await requireReviewer();
  return gateDecision(reportId, () => rejectAtGate(reportId, session.login, spam === true));
}

/** Release an outside report from the gate into the normal analysis-only run. */
export async function runAnalysisAction(reportId: string): Promise<ActionResult> {
  const session = await requireReviewer();
  return gateDecision(reportId, () => releaseForAnalysis(reportId, session.login));
}

/**
 * Close an outside report as a duplicate of an existing one and send the fixed duplicate reply.
 * The reviewer's click is the approval of that fixed text. Calling it again on a report already
 * closed as that duplicate re-sends a reply that failed, and closes nothing twice.
 */
export async function markDuplicateAction(
  reportId: string,
  duplicateOfId: string,
): Promise<ActionResult> {
  const session = await requireReviewer();
  // Accept the short id printed on a case file (`#725dcfed`), not just the full uuid: a reviewer
  // pastes what they can see. A prefix that names no report, or more than one, is refused here.
  const resolved = await resolveReportId(duplicateOfId);
  if (!resolved) return { ok: false, error: "That is not a report id." };
  return gateDecision(reportId, () => markDuplicateAtGate(reportId, resolved, session.login));
}

export async function retryRecheckAction(reportId: string, runId: string): Promise<ActionResult> {
  await requireReviewer();
  if (!isReportId(reportId) || !isReportId(runId)) return { ok: false, error: RUN_NOT_FOUND };
  try {
    const result = await retryRecheck(reportId, runId);
    revalidateReportViews(reportId);
    return result.ok ? { ok: true } : { ok: false, error: result.reason };
  } catch (error) {
    return thrownActionError(error, "retry");
  }
}

export async function cancelRecheckAction(reportId: string, runId: string): Promise<ActionResult> {
  await requireReviewer();
  if (!isReportId(reportId) || !isReportId(runId)) return { ok: false, error: RUN_NOT_FOUND };
  try {
    const result = await cancelRecheck(reportId, runId);
    revalidateReportViews(reportId);
    return result;
  } catch (error) {
    return thrownActionError(error, "cancel");
  }
}
