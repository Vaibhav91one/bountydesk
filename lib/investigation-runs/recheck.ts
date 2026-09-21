import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  agentSession,
  and,
  approvalDecision,
  db,
  eq,
  investigationRun,
  isNull,
  report,
  sql,
  verdict,
  reviewerChatMessage,
  reviewerChatThread,
  targetProfile,
  verdictSupersession,
  type Executor,
} from "@/lib/db";
import { toPlainText } from "@/lib/reviewer-chat/schema";
import { recordEvent, transition } from "@/lib/reports/lifecycle";
import { canTransition } from "@/lib/reports/states";
import { computeContentHash } from "@/lib/verdicts/hash";
import { targetIdentityHash } from "@/lib/targets/identity";

/** Guidance shares the chat message bounds and normalization: bounded, plain text, untrusted. */
// Keep above MAX_RECHECK_NOTE_LENGTH so the default plus a full note still fits.
export const GUIDANCE_MAX_LENGTH = 4_000;
// The coarse cap bounds the work toPlainText does. The real limit is checked after it, because
// NFKC normalization can expand characters and the stored body is the normalized one.
const guidanceSchema = z
  .string()
  .max(GUIDANCE_MAX_LENGTH * 4)
  .transform(toPlainText)
  .refine((value) => value.length > 0, { message: "Guidance cannot be empty" })
  .refine((value) => value.length <= GUIDANCE_MAX_LENGTH, { message: "Guidance is too long" });

export type RecheckResult =
  | { ok: true; runId: string }
  | { ok: false; reason: string };

export type RecheckActionResult = { ok: true } | { ok: false; reason: string };

export class RecheckRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RecheckRefused";
  }
}

/** Hash of the redacted guidance, recorded so the run is auditable without storing prose twice. */
export function guidanceHash(guidance: string): string {
  return computeContentHash(guidance);
}

/**
 * The run a re-check continues from. Reports created before investigation_run rows existed
 * have no run record, so the first re-check backfills one inside its own transaction: the
 * existing agent_session becomes run 1 (reason INITIAL), which keeps parent-run links and
 * run numbering coherent without a data migration.
 */
export async function ensureInitialRun(
  reportId: string,
  tx: Executor,
): Promise<{ id: string; runNumber: number; status: string; targetProfileId: string | null; targetIdentityHash: string | null }> {
  const [existing] = await tx
    .select({
      id: investigationRun.id,
      runNumber: investigationRun.runNumber,
      status: investigationRun.status,
      targetProfileId: investigationRun.targetProfileId,
      targetIdentityHash: investigationRun.targetIdentityHash,
    })
    .from(investigationRun)
    .where(eq(investigationRun.reportId, reportId))
    .orderBy(sql`${investigationRun.runNumber} desc`)
    .limit(1);
  if (existing) return existing;

  const [session] = await tx
    .select({
      id: agentSession.id,
      sessionId: agentSession.sessionId,
      targetProfileId: report.targetProfileId,
      targetProfileIdentityId: targetProfile.id,
      targetImageName: targetProfile.imageName,
      targetImageDigest: targetProfile.imageDigest,
      targetSnapshotId: targetProfile.snapshotId,
      targetBuildRecipeDigest: targetProfile.buildRecipeDigest,
      targetResolvedCommitSha: targetProfile.resolvedCommitSha,
      targetSourceArchiveDigest: targetProfile.sourceArchiveDigest,
    })
    .from(agentSession)
    .innerJoin(report, eq(report.id, agentSession.reportId))
    .leftJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
    .where(eq(agentSession.reportId, reportId))
    .limit(1);

  const [created] = await tx
    .insert(investigationRun)
    .values({
      id: randomUUID(),
      reportId,
      runNumber: 1,
      reason: "INITIAL",
      // Backfilled from a live report awaiting approval: started, not finished. A finishedAt
      // here would block the SUPERSEDED update below, which matches on isNull(finishedAt).
      status: "AWAITING_APPROVAL",
      trueforgeSessionId: session?.sessionId ?? null,
      targetProfileId: session?.targetProfileId ?? null,
      startedAt: new Date(),
    })
    .onConflictDoNothing({ target: [investigationRun.reportId, investigationRun.runNumber] })
    .returning({
      id: investigationRun.id,
      runNumber: investigationRun.runNumber,
      status: investigationRun.status,
      targetProfileId: investigationRun.targetProfileId,
      targetIdentityHash: investigationRun.targetIdentityHash,
    });
  if (created) return created;

  // Lost the race: read the winner.
  const [winner] = await tx
    .select({
      id: investigationRun.id,
      runNumber: investigationRun.runNumber,
      status: investigationRun.status,
      targetProfileId: investigationRun.targetProfileId,
      targetIdentityHash: investigationRun.targetIdentityHash,
    })
    .from(investigationRun)
    .where(and(eq(investigationRun.reportId, reportId), eq(investigationRun.runNumber, 1)))
    .limit(1);
  if (!winner) throw new RecheckRefused("could not establish an initial investigation run");
  return winner;
}

/**
 * Put a failed re-check run back in the queue. Only the newest run, only a REVIEWER_GUIDANCE
 * one that ended in ERROR, and only while the report still waits on it: anything else would
 * either resurrect an old run or leave a pending row no claimant selects.
 */
export async function retryRecheck(
  reportId: string,
  runId: string,
): Promise<RecheckResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: investigationRun.id,
        runNumber: investigationRun.runNumber,
        parentRunId: investigationRun.parentRunId,
        status: investigationRun.status,
        reason: investigationRun.reason,
        guidanceHash: investigationRun.guidanceHash,
        targetProfileId: investigationRun.targetProfileId,
        targetIdentityHash: investigationRun.targetIdentityHash,
        state: report.state,
      })
      .from(investigationRun)
      .innerJoin(report, eq(report.id, investigationRun.reportId))
      .where(and(eq(investigationRun.id, runId), eq(investigationRun.reportId, reportId)))
      .for("update");
    if (!row) return { ok: false, reason: "re-check run not found" };
    // Name the stored reason so a reviewer can tell a backfilled initial run from a wrong id.
    if (row.reason !== "REVIEWER_GUIDANCE")
      return { ok: false, reason: `not a re-check run (${row.reason})` };
    if (row.state !== "REPRODUCING") return { ok: false, reason: `report is ${row.state}` };
    if (row.status !== "ERROR") return { ok: false, reason: "only a failed re-check can be retried" };
    const [latest] = await tx
      .select({ id: investigationRun.id })
      .from(investigationRun)
      .where(eq(investigationRun.reportId, reportId))
      .orderBy(sql`${investigationRun.runNumber} desc`)
      .limit(1);
    if (latest?.id !== row.id) return { ok: false, reason: "only the latest re-check can be retried" };

    await tx
      .update(investigationRun)
      .set({
        status: "PENDING",
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(investigationRun.id, row.id));
    return { ok: true, runId: row.id };
  });
}

/**
 * Stop waiting on a queued or failed re-check. The old verdict is already superseded and
 * cannot be approved again, so the report moves to ANALYSIS_ONLY, where a human decides,
 * instead of staying in REPRODUCING with no run that could finish it.
 */
export async function cancelRecheck(
  reportId: string,
  runId: string,
): Promise<RecheckActionResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: investigationRun.id,
        reportId: investigationRun.reportId,
        runNumber: investigationRun.runNumber,
        status: investigationRun.status,
        reason: investigationRun.reason,
        state: report.state,
      })
      .from(investigationRun)
      .innerJoin(report, eq(report.id, investigationRun.reportId))
      .where(and(eq(investigationRun.id, runId), eq(investigationRun.reportId, reportId)))
      .for("update");
    if (!row) return { ok: false, reason: "re-check run not found" };
    // Same context as the retry path above, so both reviewer actions explain the refusal.
    if (row.reason !== "REVIEWER_GUIDANCE")
      return { ok: false, reason: `not a re-check run (${row.reason})` };
    if (row.state !== "REPRODUCING") return { ok: false, reason: `report is ${row.state}` };
    if (row.status !== "PENDING" && row.status !== "ERROR") {
      return { ok: false, reason: "only a pending or failed re-check can be cancelled" };
    }
    // Same guard as retry: cancelling an older run would move the report to ANALYSIS_ONLY while
    // a newer run is still active.
    const [latest] = await tx
      .select({ id: investigationRun.id })
      .from(investigationRun)
      .where(eq(investigationRun.reportId, reportId))
      .orderBy(sql`${investigationRun.runNumber} desc`)
      .limit(1);
    if (latest?.id !== row.id) return { ok: false, reason: "only the latest re-check can be cancelled" };

    await tx
      .update(investigationRun)
      .set({
        status: "CANCELLED",
        finishedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(investigationRun.id, row.id));
    await recordEvent(
      reportId,
      "agent.recheck_cancelled",
      { runId: row.id, runNumber: row.runNumber },
      { idempotencyKey: `agent.recheck_cancelled:${row.id}`, tx },
    );
    await transition(reportId, "REPRODUCING", "ANALYSIS_ONLY", tx);
    return { ok: true };
  });
}

/**
 * Supersede the pending verdict and open a fresh REVIEWER_GUIDANCE run, in one transaction:
 *
 * - lock report, agent_session, and verdict rows;
 * - refuse anything but AWAITING_APPROVAL with a pending tuple matching this exact verdict;
 * - recompute the payload hash server-side, never trust the caller's copy;
 * - refuse a verdict that already has a decision or a supersession row;
 * - insert the supersession link, clear the pending tuple, transition to REPRODUCING.
 *
 * The verdict row itself is never mutated; supersession is a separate immutable link.
 * The new run stays PENDING here; the continuation worker (daemon loop) claims it, provisions
 * the fresh sandbox group, and starts the new TrueForge session.
 */
export async function requestRecheck(
  reportId: string,
  verdictId: string,
  rawGuidance: string,
  reviewer: string,
): Promise<RecheckResult> {
  const parsed = guidanceSchema.safeParse(rawGuidance);
  if (!parsed.success) {
    return { ok: false, reason: `invalid guidance: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  }
  const guidance = parsed.data;

  return db.transaction(async (tx): Promise<RecheckResult> => {
    const [reportRow] = await tx
      .select({ state: report.state, targetProfileId: report.targetProfileId })
      .from(report)
      .where(eq(report.id, reportId))
      .for("update");
    if (!reportRow) return { ok: false, reason: "report not found" };

    const [session] = await tx
      .select()
      .from(agentSession)
      .where(eq(agentSession.reportId, reportId))
      .for("update");
    if (!session) return { ok: false, reason: "no agent session for this report" };
    const [target] = reportRow.targetProfileId
      ? await tx
          .select({
            id: targetProfile.id,
            imageName: targetProfile.imageName,
            imageDigest: targetProfile.imageDigest,
            snapshotId: targetProfile.snapshotId,
            buildRecipeDigest: targetProfile.buildRecipeDigest,
            resolvedCommitSha: targetProfile.resolvedCommitSha,
            sourceArchiveDigest: targetProfile.sourceArchiveDigest,
          })
          .from(targetProfile)
          .where(eq(targetProfile.id, reportRow.targetProfileId))
          .limit(1)
      : [undefined];

    const [v] = await tx
      .select()
      .from(verdict)
      .where(and(eq(verdict.id, verdictId), eq(verdict.reportId, reportId)))
      .limit(1)
      .for("update");
    if (!v) return { ok: false, reason: "verdict not found for this report" };

    if (reportRow.state !== "AWAITING_APPROVAL") {
      return { ok: false, reason: `report is ${reportRow.state}; only a pending approval can be superseded` };
    }
    if (!session.pendingVerdictId || session.pendingVerdictId !== v.id) {
      return { ok: false, reason: "this verdict is not the pending one awaiting review" };
    }
    if (session.pendingApprovedContentHash !== computeContentHash(v.payload)) {
      return { ok: false, reason: "content hash mismatch; refresh and retry" };
    }

    const [decision] = await tx
      .select({ id: approvalDecision.id })
      .from(approvalDecision)
      .where(eq(approvalDecision.verdictId, v.id))
      .limit(1);
    if (decision) return { ok: false, reason: "verdict already has an approval decision" };

    const [superseded] = await tx
      .select({ id: verdictSupersession.id })
      .from(verdictSupersession)
      .where(eq(verdictSupersession.oldVerdictId, v.id))
      .limit(1);
    if (superseded) return { ok: false, reason: "verdict has already been superseded" };

    if (!canTransition(reportRow.state, "REPRODUCING")) {
      return { ok: false, reason: `report cannot move from ${reportRow.state} to REPRODUCING` };
    }

    const parentRun = await ensureInitialRun(reportId, tx);

    const hash = guidanceHash(guidance);
    let [thread] = await tx
      .select({ id: reviewerChatThread.id })
      .from(reviewerChatThread)
      .where(
        and(
          eq(reviewerChatThread.reportId, reportId),
          eq(reviewerChatThread.verdictId, v.id),
        ),
      )
      .orderBy(sql`${reviewerChatThread.createdAt} desc`)
      .limit(1);
    if (!thread) {
      [thread] = await tx
        .insert(reviewerChatThread)
        .values({
          reportId,
          verdictId: v.id,
          verdictRevision: v.revision,
          verdictContentHash: v.contentHash,
          reviewerId: reviewer,
        })
        .returning({ id: reviewerChatThread.id });
    }
    await tx.insert(reviewerChatMessage).values({
      threadId: thread.id,
      clientRequestId: `recheck:${randomUUID()}`,
      sender: "REVIEWER",
      body: guidance,
      bodyHash: hash,
    });

    const [run] = await tx
      .insert(investigationRun)
      .values({
        reportId,
        runNumber: parentRun.runNumber + 1,
        parentRunId: parentRun.id,
        reason: "REVIEWER_GUIDANCE",
        status: "PENDING",
        targetProfileId: parentRun.targetProfileId,
        targetIdentityHash:
          target?.id && target.imageDigest
            ? targetIdentityHash({
                profileId: target.id,
                imageName: target.imageName,
                imageDigest: target.imageDigest,
                snapshotId: target.snapshotId,
                buildRecipeDigest: target.buildRecipeDigest,
                resolvedCommitSha: target.resolvedCommitSha,
                sourceArchiveDigest: target.sourceArchiveDigest,
              })
            : parentRun.targetIdentityHash,
        guidanceHash: hash,
      })
      .onConflictDoNothing({ target: [investigationRun.reportId, investigationRun.runNumber] })
      .returning({ id: investigationRun.id });
    if (!run) return { ok: false, reason: "a re-check run already exists for this report" };

    await tx.insert(verdictSupersession).values({
      reportId,
      oldVerdictId: v.id,
      supersededByRunId: run.id,
      reason: "reviewer-guided-recheck",
      actor: reviewer,
      guidanceHash: hash,
    });

    // The pending tuple this verdict hung on is gone with it; the fresh run will set its own.
    await tx
      .update(agentSession)
      .set({
        pendingThreadId: null,
        pendingToolCallId: null,
        pendingVerdictId: null,
        pendingApprovedContentHash: null,
        turnStatus: "CANCELLED",
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        fence: sql`${agentSession.fence} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(agentSession.id, session.id));

    // Park the parent run as superseded; the fresh run takes over the lifecycle.
    await tx
      .update(investigationRun)
      .set({ status: "SUPERSEDED", finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(investigationRun.id, parentRun.id), isNull(investigationRun.finishedAt)));

    await transition(reportId, reportRow.state, "REPRODUCING", tx);

    return { ok: true, runId: run.id };
  });
}
