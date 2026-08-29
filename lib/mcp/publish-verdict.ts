import { randomUUID } from "node:crypto";

import { z } from "zod";

import { agentSession, and, approvalDecision, db, eq, report, verdict, type Executor } from "@/lib/db";
import { enqueueDelivery } from "@/lib/delivery/queue";
import { transition } from "@/lib/reports/lifecycle";
import { hasActiveRepositoryGrant, loadRepositoryGrantSnapshot } from "@/lib/targets/repository-grant";
import { ensureInitialVerdict } from "@/lib/verdicts/lifecycle";
import { computeContentHash } from "@/lib/verdicts/hash";

export type PublishVerdictResult = { ok: true } | { ok: false; reason: string };

/**
 * The one shared shape for what an agent-drafted verdict looks like, imported by both the MCP
 * route (capability-only lookup, unchanged in this PR) and the poller (the full shape, once a
 * real agent starts drafting outcome/summary/findings instead of only echoing a capability
 * token back). One definition means the two can never quietly drift on what counts as a valid
 * draft.
 */
export const findingSchema = z.object({
  title: z.string().min(1).max(200),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  description: z.string().min(1).max(4000),
  evidenceRef: z.string().min(1),
});

export const verdictDraftSchema = z.object({
  outcome: z.enum(["REPRODUCED", "NOT_REPRODUCED", "ANALYSIS_ONLY"]),
  summary: z.string().min(1).max(2000),
  findings: z.array(findingSchema).max(20),
});

export const publishVerdictInputSchema = verdictDraftSchema.extend({
  capability: z.string(),
});

export type Finding = z.infer<typeof findingSchema>;
export type VerdictDraft = z.infer<typeof verdictDraftSchema>;
export type PublishVerdictInput = z.infer<typeof publishVerdictInputSchema>;

export type DraftVerdictResult = { ok: true; verdictId: string } | { ok: false; reason: string };

function renderFinding(finding: Finding, index: number): string {
  return `${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title}\n   ${finding.description}\n   Evidence: ${finding.evidenceRef}`;
}

/**
 * Server-authored prose for an agent-drafted verdict: the only thing that turns the agent's
 * structured fields into the exact text a human approves and GitHub receives. Same reasoning
 * as trueforge-driver.ts's buildReproducedPayload -- the agent's raw words never reach the
 * outbound comment unrendered, which matters doubly here since the agent may have absorbed
 * prompt-injection content while probing an untrusted target.
 */
export function buildAgentDraftedPayload(verdictId: string, draft: VerdictDraft): string {
  const findingsBlock =
    draft.findings.length > 0
      ? `\n\nFindings:\n${draft.findings.map(renderFinding).join("\n")}`
      : "";

  const body = `${draft.summary}${findingsBlock}\n\nA person still needs to review this before any next step.`;
  return `${body}\n\n<!-- bountydesk-delivery:${verdictId} -->`;
}

/**
 * The validated draft, an authorization re-check, rendering, and the actual write -- shared by
 * both callers below so neither re-implements any of it.
 *
 * The authorization re-check is the load-bearing part: an agent claiming REPRODUCED or
 * NOT_REPRODUCED for a report with no bound target profile, or one whose repository grant has
 * since been revoked, is refused here before its claim ever becomes a verdict row, the same way
 * decideFreshVerdict refuses an unauthorized reproduction today. ANALYSIS_ONLY needs no live
 * authorization, since it never claims the sandboxed target actually confirmed anything.
 */
async function persistAgentDraftedVerdict(
  reportId: string,
  verdictId: string,
  draft: VerdictDraft,
  tx: Executor,
): Promise<DraftVerdictResult> {
  if (draft.outcome === "REPRODUCED" || draft.outcome === "NOT_REPRODUCED") {
    const grant = await loadRepositoryGrantSnapshot(reportId, tx);
    if (!grant || !hasActiveRepositoryGrant(grant)) {
      return {
        ok: false,
        reason: `outcome ${draft.outcome} requires a bound target with an active repository grant; only ANALYSIS_ONLY is permitted here`,
      };
    }
  }

  const payload = buildAgentDraftedPayload(verdictId, draft);
  const row = await ensureInitialVerdict(
    {
      id: verdictId,
      reportId,
      outcome: draft.outcome,
      summary: draft.summary,
      evidence: { source: "agent-drafted", findings: draft.findings },
      payload,
    },
    tx,
  );
  return { ok: true, verdictId: row.id };
}

/**
 * Called from lib/agent-sessions/poller.ts once it has parsed a pending publish_verdict call's
 * arguments into the full draft shape. Resolves the report from the capability token -- the
 * model never supplies a report or verdict id directly -- then reuses whatever revision-1
 * verdict id already exists for retry-safety, or mints a fresh one.
 *
 * Rejects an invalid draft before touching the database at all: schema validation runs first,
 * outside any transaction.
 */
export async function draftVerdictFromPendingCall(
  capability: string,
  rawDraft: unknown,
): Promise<DraftVerdictResult> {
  const parsed = verdictDraftSchema.safeParse(rawDraft);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `invalid draft: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    };
  }
  const draft = parsed.data;

  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ reportId: agentSession.reportId })
      .from(agentSession)
      .where(eq(agentSession.capabilityToken, capability))
      .limit(1)
      .for("update");
    if (!session) return { ok: false, reason: "unknown capability" };

    const [existing] = await tx
      .select({ id: verdict.id })
      .from(verdict)
      .where(and(eq(verdict.reportId, session.reportId), eq(verdict.revision, 1)))
      .limit(1);
    const verdictId = existing?.id ?? randomUUID();

    return persistAgentDraftedVerdict(session.reportId, verdictId, draft, tx);
  });
}

/**
 * Used only by trueforge-driver.ts's still-deterministic ensureSession, for a report that has
 * no agent session or capability token yet at the point its verdict is decided (session
 * creation happens later, once the verdict already exists -- see the comment at that call
 * site). draftVerdictFromPendingCall's capability-based lookup doesn't apply there, so the
 * driver calls this directly with the reportId and verdictId it already computed, reusing the
 * exact same validation, authorization re-check, and rendering.
 */
export async function draftVerdictForReport(
  reportId: string,
  verdictId: string,
  rawDraft: unknown,
  tx: Executor,
): Promise<DraftVerdictResult> {
  const parsed = verdictDraftSchema.safeParse(rawDraft);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `invalid draft: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    };
  }
  return persistAgentDraftedVerdict(reportId, verdictId, parsed.data, tx);
}

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

    // Belt-and-suspenders: every outcome the driver can actually produce is publishable once a
    // human has approved it, so this only guards against a value nothing in this codebase
    // writes today (INCONCLUSIVE is in the schema enum but no driver ever emits it).
    const publishableOutcomes: (typeof verdict.outcome.enumValues)[number][] = [
      "ANALYSIS_ONLY",
      "REPRODUCED",
      "NOT_REPRODUCED",
    ];
    if (!publishableOutcomes.includes(verdictRow.outcome)) {
      return { ok: false, reason: "verdict outcome is not publishable" };
    }

    const [reportRow] = await tx
      .select({ channel: report.channel, sourceRef: report.sourceRef })
      .from(report)
      .where(eq(report.id, verdictRow.reportId))
      .limit(1);

    if (!reportRow) return { ok: false, reason: "report not found" };
    if (reportRow.channel !== "github") {
      return { ok: false, reason: `unsupported delivery channel: ${reportRow.channel}` };
    }
    if (!/^github:\d+:issue:\d+$/.test(reportRow.sourceRef)) {
      return { ok: false, reason: "invalid GitHub delivery target" };
    }

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
