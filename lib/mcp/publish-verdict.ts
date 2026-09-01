import { randomUUID } from "node:crypto";

import {
  agentSession,
  and,
  approvalDecision,
  db,
  eq,
  report,
  REPORT_TERMINAL_STATES,
  targetProfile,
  verdict,
  type Executor,
} from "@/lib/db";
import { recordVerdictArtifacts } from "@/lib/artifacts/record";
import { enqueueDelivery } from "@/lib/delivery/queue";
import { transition } from "@/lib/reports/lifecycle";
import { teardownSandbox } from "@/lib/sandbox/provision";
import { hasActiveRepositoryGrant, loadRepositoryGrantSnapshot } from "@/lib/targets/repository-grant";
import { ensureInitialVerdict } from "@/lib/verdicts/lifecycle";
import { computeContentHash } from "@/lib/verdicts/hash";

export type PublishVerdictResult = { ok: true } | { ok: false; reason: string };
export type EnqueueApprovedVerdictDeliveryResult =
  | { ok: true; deliveryId: string }
  | { ok: false; reason: string };

export {
  findingSchema,
  publishVerdictInputSchema,
  verdictDraftSchema,
  type Finding,
  type PublishVerdictInput,
  type VerdictDraft,
} from "@/lib/mcp/verdict-draft";
import { verdictDraftSchema, type Finding, type VerdictDraft } from "@/lib/mcp/verdict-draft";

export type DraftVerdictResult = { ok: true; verdictId: string } | { ok: false; reason: string };

function renderFinding(finding: Finding, index: number): string {
  // A subheading carrying the severity, then the description. GitHub renders this as a heading
  // and a paragraph; the reviewer's UI reads the same structured fields directly rather than
  // this string.
  //
  // The evidence reference the agent cited is deliberately not in here. It names a file inside
  // the harness sandbox, so on a public issue it is a path the reporter cannot open and would
  // read as a broken link to proof. The reference is kept on the verdict and written into the
  // findings artifact a reviewer can download.
  return `### ${index + 1}. ${finding.title} (${finding.severity.toUpperCase()})\n\n${finding.description}`;
}

/**
 * Server-authored markdown for an agent-drafted verdict: the only thing that turns the agent's
 * structured fields into the exact text a human approves and GitHub receives. The agent's raw
 * words never reach the outbound comment unrendered, which matters doubly here since the
 * agent may have absorbed prompt-injection content while probing an untrusted target.
 */
export type TargetRef = { imageName: string; imageDigest: string };

export function buildAgentDraftedPayload(
  verdictId: string,
  draft: VerdictDraft,
  targetRef?: TargetRef | null,
): string {
  const findingsBlock =
    draft.findings.length > 0
      ? `\n\n## Findings\n\n${draft.findings.map(renderFinding).join("\n\n")}`
      : "";

  // The target the report was reproduced against, named by its durable digest, when the target
  // came through the onboarding pipeline. The digest is stable and checkable; a signed download
  // URL would expire and, being non-deterministic, would also change the content hash the human
  // approved. This line is part of the hashed, approved bytes, so a reviewer sees it before
  // signing and the delivery worker posts it verbatim.
  const targetBlock = targetRef
    ? `\n\n## Target image\n\n${targetRef.imageName}@${targetRef.imageDigest}`
    : "";

  // The outcome heads the comment on its own line, in the outbound comment's own words, rather
  // than left for the free-form summary to convey: a draft's `summary` is validated only for
  // length, not for agreeing with its own `outcome`, so the approved text must state the
  // persisted outcome plainly instead of relying on the agent's prose to get it right.
  const body = `## Outcome: ${draft.outcome}\n\n## Summary\n\n${draft.summary}${findingsBlock}${targetBlock}`;
  return `${body}\n\n<!-- bountydesk-delivery:${verdictId} -->`;
}

/**
 * The fixed text of a server-synthesized ANALYSIS_ONLY verdict. A run that ends without the
 * agent ever drafting a verdict still needs something a human can approve and deliver, and this
 * is it. The wording is a constant, never the agent's output or a tool result or the run's
 * lastError string: those can carry a secret or prompt-injection content absorbed from an
 * untrusted target, and none of that belongs in an outbound GitHub comment.
 */
export const SYNTHESIZED_ANALYSIS_SUMMARY =
  "Automated investigation could not complete or verify this report. It is surfaced for human triage; a reviewer should read the report and decide whether it is valid.";

/**
 * Mint the server-authored ANALYSIS_ONLY verdict for a report whose agent run reached a dead
 * end (a pending call the poller cannot resolve, or a turn that finished with no publish_verdict
 * draft) so the report still carries something a human can approve rather than sitting stuck at
 * ANALYSIS_ONLY with nothing to approve. Returns the verdict id and its content hash for the
 * caller to bind the pending approval to.
 *
 * Only ever ANALYSIS_ONLY, and only when the report has no verdict yet: an existing verdict is
 * never overwritten, and a REPRODUCED or NOT_REPRODUCED claim is never synthesized here. Runs
 * inside the caller's transaction, so it commits or rolls back with the lifecycle move around it.
 */
export async function synthesizeAnalysisOnlyVerdict(
  reportId: string,
  tx: Executor,
): Promise<{ verdictId: string; contentHash: string } | null> {
  const [existing] = await tx
    .select({ id: verdict.id })
    .from(verdict)
    .where(and(eq(verdict.reportId, reportId), eq(verdict.revision, 1)))
    .limit(1);
  if (existing) return null;

  // The same authorization gate the agent-drafted path runs, in this same transaction: it
  // refuses a terminal or DELIVERING report, and it permits ANALYSIS_ONLY with no target or a
  // revoked grant, which is exactly the intended outcome for those reports (see the gate's
  // doc). The poller only calls this from TRIAGING/REPRODUCING, so a refusal is a genuine race
  // worth surfacing rather than swallowing.
  const allowed = await assertVerdictInsertAllowed(reportId, "ANALYSIS_ONLY", tx);
  if (!allowed.ok) {
    throw new Error(
      `cannot synthesize ANALYSIS_ONLY verdict for report ${reportId}: ${allowed.reason}`,
    );
  }

  const verdictId = randomUUID();
  const draft: VerdictDraft = {
    outcome: "ANALYSIS_ONLY",
    summary: SYNTHESIZED_ANALYSIS_SUMMARY,
    findings: [],
  };
  const row = await ensureInitialVerdict(
    {
      id: verdictId,
      reportId,
      outcome: "ANALYSIS_ONLY",
      summary: SYNTHESIZED_ANALYSIS_SUMMARY,
      evidence: { source: "server-synthesized" },
      payload: buildAgentDraftedPayload(verdictId, draft),
    },
    tx,
  );
  return { verdictId: row.id, contentHash: row.contentHash };
}

/**
 * The authorization gate every verdict insertion shares, run inside the caller's transaction so
 * it commits or rolls back with the insert. Two rules:
 *
 * A report past the analysis stages is refused regardless of outcome: a revision-1 verdict is
 * the insertion's idempotency key, so writing one for a cancelled, expired, delivered, denied,
 * out-of-scope, or already-delivering report would permanently attach a definitive verdict to a
 * report that can never again legitimately produce one.
 *
 * A REPRODUCED or NOT_REPRODUCED claim needs a bound target with an active repository grant; an
 * agent's claim to the contrary is refused here before it becomes a verdict row, the only place
 * that enforcement happens now that trueforge-driver.ts pre-decides nothing. ANALYSIS_ONLY is
 * permitted with no target and with a revoked grant on purpose: it never asserts the sandboxed
 * target confirmed anything, and it is the correct outcome for exactly those reports (AGENTS.md:
 * "No bound target, no REPRODUCED... that run stays ANALYSIS_ONLY"). The delivery worker still
 * re-checks the live GitHub grant (lib/github/lifecycle.ts activeRepository: installation
 * unsuspended, repository active with a bound target profile) before it mints a token or posts,
 * so a revoked-grant report can be surfaced for human triage but never actually posted while the
 * grant is gone.
 */
async function assertVerdictInsertAllowed(
  reportId: string,
  outcome: (typeof verdict.outcome.enumValues)[number],
  tx: Executor,
): Promise<PublishVerdictResult> {
  const [reportRow] = await tx
    .select({ state: report.state })
    .from(report)
    .where(eq(report.id, reportId))
    .limit(1)
    .for("update");
  if (!reportRow) return { ok: false, reason: "report not found" };
  if (
    (REPORT_TERMINAL_STATES as readonly string[]).includes(reportRow.state) ||
    reportRow.state === "DELIVERING"
  ) {
    return {
      ok: false,
      reason: `report is ${reportRow.state}; a fresh verdict cannot be drafted for it`,
    };
  }
  if (outcome === "REPRODUCED" || outcome === "NOT_REPRODUCED") {
    const grant = await loadRepositoryGrantSnapshot(reportId, tx);
    if (!grant || !hasActiveRepositoryGrant(grant)) {
      return {
        ok: false,
        reason: `outcome ${outcome} requires a bound target with an active repository grant; only ANALYSIS_ONLY is permitted here`,
      };
    }
  }
  return { ok: true };
}

/**
 * The agent-drafted write: run the shared authorization gate, render the payload, and insert.
 * Evidence is labelled agent-drafted here; the server-synthesized path mints its own row with
 * its own label but through the same gate.
 */
async function persistAgentDraftedVerdict(
  reportId: string,
  verdictId: string,
  draft: VerdictDraft,
  tx: Executor,
): Promise<DraftVerdictResult> {
  const allowed = await assertVerdictInsertAllowed(reportId, draft.outcome, tx);
  if (!allowed.ok) return allowed;

  // The image the report was reproduced against, if it has a bound target with a digest. Cited
  // in the approved comment; absent for a target-less report, which simply gets no target line.
  const [targetRow] = await tx
    .select({ imageName: targetProfile.imageName, imageDigest: targetProfile.imageDigest })
    .from(report)
    .innerJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
    .where(eq(report.id, reportId))
    .limit(1);
  const targetRef =
    targetRow?.imageName && targetRow.imageDigest
      ? { imageName: targetRow.imageName, imageDigest: targetRow.imageDigest }
      : null;

  const payload = buildAgentDraftedPayload(verdictId, draft, targetRef);
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
 *
 * A successful persist is the agent's investigation ending -- publish_verdict is the last tool
 * call a turn makes, so this is one of the three terminal points AGENTS.md's teardown section
 * names, and the session's sandbox (if it had one) is torn down here. The delete itself runs
 * after the transaction commits, not inside it: same reasoning as provisionTarget staying
 * outside trueforge-driver.ts's row lock, a Daytona network call is not something to hold a
 * Postgres lock across. Best-effort, matching reproduce.ts's own pattern -- a teardown failure
 * is logged, never allowed to turn a successful publish into a thrown error.
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

  let sandboxToTearDown: string | null = null;
  let reportForArtifacts: string | null = null;

  const result = await db.transaction(async (tx): Promise<DraftVerdictResult> => {
    const [session] = await tx
      .select({ reportId: agentSession.reportId, sandboxId: agentSession.sandboxId })
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

    const outcome = await persistAgentDraftedVerdict(session.reportId, verdictId, draft, tx);
    if (outcome.ok) {
      sandboxToTearDown = session.sandboxId;
      reportForArtifacts = session.reportId;
    }
    return outcome;
  });

  if (result.ok && reportForArtifacts) {
    // After the commit, not inside it: producing the transcript re-reads session_event and the
    // uploads are network calls, neither of which belongs inside the report's row lock. Uploading
    // the bytes of a payload that has not committed would also be wrong. recordVerdictArtifacts is
    // best-effort and never throws, so it cannot turn a successful publish into a failure.
    await recordVerdictArtifacts(reportForArtifacts, result.verdictId);
  }

  if (result.ok && sandboxToTearDown) {
    // cancellationInFlight: true always swallows a delete failure into a log line rather than
    // throwing -- there is no cancellation concept on this path, only "never block a successful
    // publish on cleanup."
    await teardownSandbox(sandboxToTearDown, true);
  }

  return result;
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

    const enqueued = await enqueueApprovedVerdictDelivery(
      tx,
      session.id,
      verdictRow,
      recomputedHash,
    );
    return enqueued.ok ? { ok: true } : enqueued;
  });
}

/**
 * The shared tail that turns a proven human approval into a queued delivery: check the outcome
 * is publishable, resolve the GitHub target, enqueue the outbound comment bound to the exact
 * approved hash, move the report to DELIVERING, and clear the session's pending markers.
 *
 * Both callers reach here only after proving the approval: the agent path through
 * `publishVerdict` (a recorded APPROVED decision plus three matching hashes), and the
 * synthesized path through the approval-submission worker (the same decision and hash checks,
 * minus the TrueForge round-trip a synthesized verdict has no call for). This function itself
 * assumes that proof and never re-derives consent; it takes the verdict and the hash the caller
 * already verified.
 */
export async function enqueueApprovedVerdictDelivery(
  tx: Executor,
  sessionId: string,
  verdictRow: {
    id: string;
    reportId: string;
    outcome: (typeof verdict.outcome.enumValues)[number];
  },
  approvedContentHash: string,
): Promise<EnqueueApprovedVerdictDeliveryResult> {
  // Belt-and-suspenders: every outcome the driver can actually produce is publishable once a
  // human has approved it, so this only guards against a value nothing in this codebase writes
  // today (INCONCLUSIVE is in the schema enum but no driver ever emits it).
  const publishableOutcomes: (typeof verdict.outcome.enumValues)[number][] = [
    "ANALYSIS_ONLY",
    "REPRODUCED",
    "NOT_REPRODUCED",
  ];
  if (!publishableOutcomes.includes(verdictRow.outcome)) {
    return { ok: false, reason: "verdict outcome is not publishable" };
  }

  const [reportRow] = await tx
    .select({ channel: report.channel, sourceRef: report.sourceRef, state: report.state })
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

  const canDeliver =
    reportRow.state === "AWAITING_APPROVAL" ||
    (reportRow.state === "ANALYSIS_ONLY" && verdictRow.outcome === "ANALYSIS_ONLY");
  if (!canDeliver) {
    return { ok: false, reason: `report is ${reportRow.state}; approved verdict cannot deliver` };
  }

  const delivery = await enqueueDelivery(
    {
      reportId: verdictRow.reportId,
      verdictId: verdictRow.id,
      idempotencyKey: `verdict:${verdictRow.id}`,
      target: reportRow.sourceRef,
      // The hash this write commits to is the one the caller just verified, not a second,
      // unverified read of the same column: a `verdict` row is immutable, so the two should
      // always agree, but the outbox must never bind to a value nobody checked the moment
      // before enqueueing.
      approvedContentHash,
    },
    tx,
  );

  await transition(verdictRow.reportId, reportRow.state, "DELIVERING", tx);

  await tx
    .update(agentSession)
    .set({
      pendingThreadId: null,
      pendingToolCallId: null,
      pendingVerdictId: null,
      pendingApprovedContentHash: null,
      updatedAt: new Date(),
    })
    .where(eq(agentSession.id, sessionId));

  return { ok: true, deliveryId: delivery.id };
}
