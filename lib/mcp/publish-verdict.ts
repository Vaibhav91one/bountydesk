import { agentSession, approvalDecision, db, eq, report, verdict } from "@/lib/db";
import { enqueueDelivery } from "@/lib/delivery/queue";
import { transition } from "@/lib/reports/lifecycle";
import { computeContentHash } from "@/lib/verdicts/hash";

export type PublishVerdictResult = { ok: true } | { ok: false; reason: string };

/**
 * The MCP tool handler for `publish_verdict`. Resolves everything from the opaque
 * `capability` token; the model never supplies a report or verdict id directly.
 *
 * This function never records an approval, it only checks that one already exists. An
 * earlier draft had this handler write the approval_decision row itself on the reasoning
 * that TrueForge only calls this tool after a human clicked Allow. That was rejected: the
 * bearer secret in front of this route is shared with TrueForge, so anyone who could reach
 * the route could claim the same thing. A separate reviewer-facing action writes the
 * approval_decision row first; this handler's whole job is to verify it, not create it.
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

    const recomputedHash = computeContentHash(verdictRow.payload);
    if (
      recomputedHash !== session.pendingApprovedContentHash ||
      recomputedHash !== decision.payloadHash
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
        approvedContentHash: verdictRow.contentHash,
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
