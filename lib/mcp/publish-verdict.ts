import { randomUUID } from "node:crypto";

import {
  agentSession,
  and,
  approvalDecision,
  connectedRepository,
  db,
  desc,
  eq,
  gt,
  report,
  REPORT_TERMINAL_STATES,
  sessionEvent,
  sql,
  targetOnboarding,
  targetProfile,
  verdict,
  verdictSupersession,
  type Executor,
} from "@/lib/db";
import {
  isStaticFallbackReason,
  STATIC_FALLBACK_EVENT,
  type StaticFallbackReason,
} from "@/lib/analysis/static-review";
import { recordVerdictArtifacts } from "@/lib/artifacts/record";
import { isVerifiedEmailRecipient } from "@/lib/email/recipient";
import { enqueueDelivery } from "@/lib/delivery/queue";
import { transition } from "@/lib/reports/lifecycle";
import { teardownSandbox } from "@/lib/sandbox/provision";
import { hasActiveRepositoryGrant, loadRepositoryGrantSnapshot } from "@/lib/targets/repository-grant";
import { appendVerdictRevision, ensureInitialVerdict, nextVerdictRevision } from "@/lib/verdicts/lifecycle";
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
/**
 * Why reproduction was not available for this report, for the synthesized verdict's evidence. Only
 * server-derived facts go in: the report's own target binding and the onboarding state of its repo,
 * both enums the platform set, never agent output or a tool result. So a reviewer reading the case
 * file can tell "the repository cannot be onboarded for reproduction" from "no target is bound",
 * without any untrusted text entering the verdict record. The specific onboarding reason (which for
 * an agent-refused repo is agent-authored text) stays in the connections UI, not here.
 */
async function reproductionUnavailabilityEvidence(reportId: string, tx: Executor): Promise<Record<string, string>> {
  const [row] = await tx
    .select({ onboardingState: targetOnboarding.state })
    .from(report)
    .leftJoin(connectedRepository, eq(connectedRepository.id, report.connectedRepositoryId))
    .leftJoin(targetOnboarding, eq(targetOnboarding.repoId, connectedRepository.repoId))
    .where(eq(report.id, reportId))
    .limit(1);
  if (row?.onboardingState === "UNSUPPORTED") {
    return { reproduction: "unavailable", reason: "repository-not-onboardable" };
  }
  return { reproduction: "unavailable", reason: "no-reproduction-target" };
}

/**
 * The reason recorded with this report's static-review turn (lib/analysis/trueforge-driver.ts), or
 * null when its turn was an ordinary one. The event is written in the same transaction that stored
 * the turn, and session_event rows cannot be edited, so this is server-authored and stable.
 */
async function staticFallbackReason(reportId: string, tx: Executor): Promise<StaticFallbackReason | null> {
  const [row] = await tx
    .select({ data: sessionEvent.data })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.reportId, reportId), eq(sessionEvent.type, STATIC_FALLBACK_EVENT)))
    .orderBy(desc(sessionEvent.seq))
    .limit(1);
  const reason = (row?.data as { reason?: unknown } | undefined)?.reason;
  return isStaticFallbackReason(reason) ? reason : null;
}

async function analysisOnlyReasonEvidence(reportId: string, tx: Executor): Promise<{ analysisOnlyReason?: StaticFallbackReason }> {
  const reason = await staticFallbackReason(reportId, tx);
  return reason ? { analysisOnlyReason: reason } : {};
}

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
      // The outbound summary stays constant; the evidence (reviewer-facing, not the GitHub comment)
      // carries the server-derived reason reproduction was unavailable.
      evidence: {
        source: "server-synthesized",
        ...(await reproductionUnavailabilityEvidence(reportId, tx)),
        ...(await analysisOnlyReasonEvidence(reportId, tx)),
      },
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

  // A static-review run never had a running target, whatever the agent concluded from the source,
  // so a definitive outcome is refused here even when the target and its grant are otherwise fine.
  // Only the initial run is held to this: a later re-check boots the target again on its own terms.
  const staticReason = await staticFallbackReason(reportId, tx);
  if (staticReason && draft.outcome !== "ANALYSIS_ONLY") {
    return {
      ok: false,
      reason: `outcome ${draft.outcome} is refused: this run was a static review (${staticReason}) with no running target; only ANALYSIS_ONLY is permitted`,
    };
  }

  // The image the report was reproduced against, if it has a bound target with a digest. Cited
  // in the approved comment; absent for a target-less report, which simply gets no target line.
  const [targetRow] = await tx
    .select({ imageName: targetProfile.imageName, imageDigest: targetProfile.imageDigest })
    .from(report)
    .innerJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
    .where(eq(report.id, reportId))
    .limit(1);
  let targetRef =
    targetRow?.imageName && targetRow.imageDigest
      ? { imageName: targetRow.imageName, imageDigest: targetRow.imageDigest }
      : null;

  // The poller replays a parked publish_verdict call on every poll, and ensureInitialVerdict
  // proves the replay is the same draft by comparing re-rendered bytes. The target line is the
  // one part of those bytes that comes from the report rather than the draft, and a reviewer can
  // bind a target after the draft was written. Re-render the replay the way it was drafted: if
  // the stored revision is exactly this draft rendered with no target, it predates the bind.
  // Only a byte-exact match of our own rendering qualifies, so a different draft still fails.
  if (targetRef) {
    const [stored] = await tx
      .select({ payload: verdict.payload })
      .from(verdict)
      .where(and(eq(verdict.reportId, reportId), eq(verdict.revision, 1)))
      .limit(1);
    if (stored && stored.payload === buildAgentDraftedPayload(verdictId, draft, null)) {
      targetRef = null;
    }
  }

  const payload = buildAgentDraftedPayload(verdictId, draft, targetRef);
  const row = await ensureInitialVerdict(
    {
      id: verdictId,
      reportId,
      outcome: draft.outcome,
      summary: draft.summary,
      evidence: {
        source: "agent-drafted",
        findings: draft.findings,
        ...(staticReason ? { analysisOnlyReason: staticReason } : {}),
      },
      payload,
    },
    tx,
  );
  return { ok: true, verdictId: row.id };
}

/**
 * The target reference a rebuilt payload needs to compare against a stored content hash: the
 * same select persistFollowUpVerdict uses, factored out so both stay identical.
 */
async function targetRefForReport(
  reportId: string,
  tx: Executor,
): Promise<{ imageName: string; imageDigest: string } | null> {
  const [targetRow] = await tx
    .select({ imageName: targetProfile.imageName, imageDigest: targetProfile.imageDigest })
    .from(report)
    .innerJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
    .where(eq(report.id, reportId))
    .limit(1);
  return targetRow?.imageName && targetRow.imageDigest
    ? { imageName: targetRow.imageName, imageDigest: targetRow.imageDigest }
    : null;
}

/**
 * The re-check run's write: same authorization gate as the initial draft, but the revision is
 * the next one on record rather than 1, and no superseded verdict can be re-drafted. An
 * append, not an update: the old revision stays immutable history.
 */
async function persistFollowUpVerdict(
  reportId: string,
  verdictId: string,
  revision: number,
  draft: VerdictDraft,
  tx: Executor,
): Promise<DraftVerdictResult> {
  const allowed = await assertVerdictInsertAllowed(reportId, draft.outcome, tx);
  if (!allowed.ok) return allowed;

  const targetRef = await targetRefForReport(reportId, tx);

  const payload = buildAgentDraftedPayload(verdictId, draft, targetRef);
  const row = await appendVerdictRevision(
    {
      id: verdictId,
      reportId,
      outcome: draft.outcome,
      summary: draft.summary,
      evidence: { source: "agent-drafted", findings: draft.findings, revision },
      payload,
      revision,
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

  let sandboxesToTearDown: string[] = [];
  let reportForArtifacts: string | null = null;

  const result = await db.transaction(async (tx): Promise<DraftVerdictResult> => {
    const [session] = await tx
      .select({ reportId: agentSession.reportId, sandboxId: agentSession.sandboxId, sandboxIds: agentSession.sandboxIds })
      .from(agentSession)
      .where(eq(agentSession.capabilityToken, capability))
      .limit(1)
      .for("update");
    if (!session) return { ok: false, reason: "unknown capability" };

    // Lock the report before allocating a revision. This serializes max+1 with another draft and
    // keeps the unique revision index from becoming the normal race detector.
    await tx.select({ id: report.id }).from(report).where(eq(report.id, session.reportId)).for("update");

    // Reuse revision 1 for initial-run retries. A follow-up run is explicitly identified by an
    // existing supersession row, so a stale retry cannot accidentally create revision 2.
    const [initial] = await tx
      .select({ id: verdict.id })
      .from(verdict)
      .where(and(eq(verdict.reportId, session.reportId), eq(verdict.revision, 1)))
      .limit(1);
    const [supersession] = await tx
      .select({ id: verdictSupersession.id })
      .from(verdictSupersession)
      .where(eq(verdictSupersession.reportId, session.reportId))
      .limit(1);

    let revision: number;
    let verdictId: string;
    if (supersession) {
      // A follow-up run drafts exactly one revision. The same pending call reaches this
      // function more than once (the poller re-reads a turn whose arguments still carry the
      // draft), so a second draft must return the revision this run already minted rather than
      // minting N+2, which would orphan the pending tuple bound to N+1 and wedge the session in
      // ERROR. Identical content is the retry; different content is a disagreement between two
      // drafts of the same run and fails loudly, the same rule ensureInitialVerdict applies.
      const [current] = await tx
        .select({ id: verdict.id, contentHash: verdict.contentHash })
        .from(verdict)
        .where(
          and(
            eq(verdict.reportId, session.reportId),
            gt(verdict.revision, 1),
            sql`${verdict.id} not in (select ${verdictSupersession.oldVerdictId} from ${verdictSupersession} where ${verdictSupersession.reportId} = ${session.reportId})`,
          ),
        )
        .orderBy(desc(verdict.revision))
        .limit(1);
      if (current) {
        const targetRow = await targetRefForReport(session.reportId, tx);
        const rebuiltPayload = buildAgentDraftedPayload(current.id, draft, targetRow);
        if (computeContentHash(rebuiltPayload) === current.contentHash) {
          sandboxesToTearDown = []; // nothing new persisted; the run's sandboxes were already torn down
          return { ok: true, verdictId: current.id };
        }
        return {
          ok: false,
          reason: "this run already drafted a different revision; a second draft cannot replace it",
        };
      }
      revision = await nextVerdictRevision(session.reportId, tx);
      verdictId = randomUUID();
    } else {
      revision = 1;
      verdictId = initial && revision === 1 ? initial.id : randomUUID();
    }

    const outcome =
      revision === 1
        ? await persistAgentDraftedVerdict(session.reportId, verdictId, draft, tx)
        : await persistFollowUpVerdict(session.reportId, verdictId, revision, draft, tx);
    if (outcome.ok) {
      sandboxesToTearDown = Array.isArray(session.sandboxIds)
        ? session.sandboxIds.filter((id): id is string => typeof id === "string")
        : session.sandboxId
          ? [session.sandboxId]
          : [];
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

  if (result.ok) {
    // Never block a successful publish on cleanup, but attempt every linked mesh sandbox.
    for (const sandboxId of sandboxesToTearDown) await teardownSandbox(sandboxId, true);
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

    // A verdict superseded by a re-check cannot be delivered even with an approval in hand:
    // the reviewer asked for a fresh investigation, so this text is no longer what they meant
    // to send. Re-checked and re-approved revisions reach here without a supersession row.
    const [supersededRow] = await tx
      .select({ id: verdictSupersession.id })
      .from(verdictSupersession)
      .where(eq(verdictSupersession.oldVerdictId, verdictRow.id))
      .limit(1);
    if (supersededRow) {
      return { ok: false, reason: "verdict has been superseded by a re-check" };
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
 * The advisory delivery target for an email report, or null when the reply is the right channel.
 *
 * "Supports advisories" is nothing more than an active grant on a bound connected repository: the
 * App already holds the advisories-write permission, so a repo we can still reach is a repo we can
 * open a draft advisory on. The pinned demo target has no connected repository (its grant snapshot
 * has a null connectedRepositoryId, which hasActiveRepositoryGrant treats as always active), so it
 * is excluded here on purpose, it delivers as an email reply. The returned target names the repo,
 * not a GHSA: an email report has no pre-existing advisory, so the arm creates one, and freezing the
 * repo id lets the worker refuse a rebind between approval and send the same way the other channels
 * refuse a moved destination.
 */
async function emailAdvisoryDeliveryTarget(reportId: string, tx: Executor): Promise<string | null> {
  const grant = await loadRepositoryGrantSnapshot(reportId, tx);
  if (!grant || !grant.connectedRepositoryId || !hasActiveRepositoryGrant(grant)) return null;
  const [repo] = await tx
    .select({ repoId: connectedRepository.repoId })
    .from(report)
    .innerJoin(connectedRepository, eq(connectedRepository.id, report.connectedRepositoryId))
    .where(eq(report.id, reportId))
    .limit(1);
  if (!repo) return null;
  return `github:${repo.repoId}:advisory:create`;
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
    .select({
      channel: report.channel,
      sourceRef: report.sourceRef,
      state: report.state,
      reporterContact: report.reporterContact,
      verifiedSender: report.verifiedSender,
    })
    .from(report)
    .where(eq(report.id, verdictRow.reportId))
    .limit(1);

  if (!reportRow) return { ok: false, reason: "report not found" };

  // The destination is decided here, once, and frozen on the outbox row. The worker re-checks it
  // against the report at send time, so a destination that moves after approval is refused rather
  // than followed. Refusing before the DELIVERING transition leaves a report that cannot be
  // delivered still approvable, rather than stranding it mid-delivery.
  let deliveryTarget: string;
  let deliveryChannel: (typeof report.channel.enumValues)[number] | undefined;
  if (reportRow.channel === "github") {
    if (!/^github:\d+:issue:\d+$/.test(reportRow.sourceRef)) {
      return { ok: false, reason: "invalid GitHub delivery target" };
    }
    deliveryTarget = reportRow.sourceRef;
  } else if (reportRow.channel === "email") {
    // An email report bound to a target whose connected repository still grants access is
    // delivered as a draft advisory, not an email reply: for a connected repo the advisory is the
    // place a vulnerability is tracked and fixed. This is decided before the email-recipient gates
    // because the advisory route mails nobody; its recipient is the repository, re-verified live by
    // the advisory arm. An email report with no such binding falls through to the reply.
    const advisoryTarget = await emailAdvisoryDeliveryTarget(verdictRow.reportId, tx);
    if (advisoryTarget) {
      deliveryTarget = advisoryTarget;
      deliveryChannel = "advisory";
    } else {
      const contact = reportRow.reporterContact?.trim().toLowerCase() ?? "";
      // The verified-recipient half of the delivery contract: no address that passed inbound
      // SPF/DKIM means there is nobody we can prove we are replying to, so no outbox row exists.
      if (!contact) {
        return { ok: false, reason: "report has no verified reporter contact to deliver to" };
      }
      if (!/^email:.+/.test(reportRow.sourceRef)) {
        return { ok: false, reason: "invalid email delivery target" };
      }
      // Intake accepts mail from an allowlisted sender, or from an outside sender whose mail passed
      // SPF and DKIM (recorded as verified_sender). Re-reading it here refuses early, before the
      // report moves to DELIVERING, if the address no longer qualifies. The worker checks again at
      // send time; this one is about not stranding the report, that one is about not mailing the
      // wrong person.
      if (!(await isVerifiedEmailRecipient(reportRow))) {
        return { ok: false, reason: `${contact} is no longer an authorised address` };
      }
      deliveryTarget = contact;
    }
  } else if (reportRow.channel === "upload") {
    // Upload rides the email transport, so its delivery target is the same OTP-verified contact and
    // the same recipient re-check. The one difference from email is the source_ref shape: an upload
    // has no inbound message to thread onto, so it is upload:<id>, not email:<message-id>.
    const contact = reportRow.reporterContact?.trim().toLowerCase() ?? "";
    if (!contact) {
      return { ok: false, reason: "report has no verified reporter contact to deliver to" };
    }
    if (!/^upload:.+/.test(reportRow.sourceRef)) {
      return { ok: false, reason: "invalid upload delivery target" };
    }
    if (!(await isVerifiedEmailRecipient(reportRow))) {
      return { ok: false, reason: `${contact} is no longer an authorised address` };
    }
    deliveryTarget = contact;
  } else if (reportRow.channel === "advisory") {
    // The verdict is written back by editing the repository's security advisory, so the delivery
    // target is the report's own source_ref (the repo id plus the GHSA id), exactly as the GitHub
    // channel targets its issue. The recipient is the connected repository, re-verified live at
    // send time by the advisory arm's activeRepository check; a grant revoked before then is
    // refused and held there rather than delivered.
    if (!/^github:\d+:advisory:.+/.test(reportRow.sourceRef)) {
      return { ok: false, reason: "invalid advisory delivery target" };
    }
    deliveryTarget = reportRow.sourceRef;
  } else {
    return { ok: false, reason: `unsupported delivery channel: ${reportRow.channel}` };
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
      target: deliveryTarget,
      channel: deliveryChannel,
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
