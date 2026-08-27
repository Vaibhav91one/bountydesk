import { agentSession, approvalDecision, db, eq, report, verdict } from "@/lib/db";
import { enqueueDelivery } from "@/lib/delivery/queue";
import { transition } from "@/lib/reports/lifecycle";
import { computeContentHash } from "@/lib/verdicts/hash";

export type PublishVerdictResult = { ok: true } | { ok: false; reason: string };

/**
 * The MCP tool handler for `publish_verdict`. Resolves everything from the opaque
 * `capability` token; the model never supplies a report or verdict id directly.
 *
 * This handler never records an approval, it only verifies one already exists: a separate
 * reviewer-facing action is the sole writer of `approval_decision`. The bearer secret in
 * front of this route authenticates "is this really TrueForge calling," not "did a human
 * approve this," so this function must never treat its own invocation as proof of consent.
 */
export async function publishVerdict(capability: string): Promise<PublishVerdictResult> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(agentSession)
      .where(eq(agentSession.capabilityToken, capability))
      .limit(1)
      .for("update");

    if (!session) return { ok: false, reason: "unknown capability" };

    // The check constraint guarantees these four columns are null or non-null together, so
    // testing one of them is enough to know whether a pending call exists at all.
    if (!session.pendingVerdictId || !session.pendingThreadId || !session.pendingToolCallId) {
      return { ok: false, reason: "no pending approval for this session" };
    }

    const [decision] = await tx
      .select()
      .from(approvalDecision)
      .where(eq(approvalDecision.verdictId, session.pendingVerdictId))
      .limit(1);

    // The core case this handler exists to enforce: no amount of TrueForge insistence
    // manufactures an approval that a human never recorded.
    if (!decision) return { ok: false, reason: "no approval recorded for this verdict" };

    if (decision.decision !== "APPROVED") return { ok: false, reason: "denied" };
    if (
      decision.threadId !== session.pendingThreadId ||
      decision.toolCallId !== session.pendingToolCallId
    ) {
      return { ok: false, reason: "stale thread/tool-call binding" };
    }

    const [verdictRow] = await tx
      .select()
      .from(verdict)
      .where(eq(verdict.id, session.pendingVerdictId))
      .limit(1);

    if (!verdictRow) return { ok: false, reason: "verdict not found" };

    // The session's own report_id and the pending verdict's report_id are independent
    // foreign keys; nothing in the schema stops them from disagreeing. Without this check a
    // mismatched pending row would let one report's capability publish a different report's
    // approved verdict.
    if (verdictRow.reportId !== session.reportId) {
      return { ok: false, reason: "verdict does not belong to this session's report" };
    }

    const recomputedHash = computeContentHash(verdictRow.payload);
    if (
      recomputedHash !== session.pendingApprovedContentHash ||
      recomputedHash !== decision.payloadHash ||
      recomputedHash !== verdictRow.contentHash
    ) {
      return { ok: false, reason: "content hash mismatch" };
    }

    // Belt-and-suspenders: nothing in this codebase can produce another outcome yet, but the
    // handler enforces it independently of whatever anyone might have approved.
    if (verdictRow.outcome !== "ANALYSIS_ONLY") {
      return { ok: false, reason: "verdict outcome is not publishable" };
    }

    const [reportRow] = await tx
      .select({ sourceRef: report.sourceRef })
      .from(report)
      .where(eq(report.id, verdictRow.reportId))
      .limit(1);

    if (!reportRow) return { ok: false, reason: "report not found" };

    await enqueueDelivery(
      {
        reportId: verdictRow.reportId,
        verdictId: verdictRow.id,
        idempotencyKey: `verdict:${verdictRow.id}`,
        target: reportRow.sourceRef,
        // The hash this write commits to is the one just verified above, not a second,
        // unverified read of the same column: a `verdict` row is immutable, so the two should
        // always agree, but the outbox must never bind to a value this handler didn't itself
        // check the moment before enqueueing.
        approvedContentHash: recomputedHash,
      },
      tx,
    );

    await transition(verdictRow.reportId, "AWAITING_APPROVAL", "DELIVERING", tx);

    await tx
      .update(agentSession)
      .set({
        pendingThreadId: null,
        pendingToolCallId: null,
        pendingVerdictId: null,
        pendingApprovedContentHash: null,
        updatedAt: new Date(),
      })
      .where(eq(agentSession.id, session.id));

    return { ok: true };
  });
}
