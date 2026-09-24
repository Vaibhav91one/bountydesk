import { and, db, desc, eq, report, sessionEvent, type Executor } from "@/lib/db";
import { noticeSent, sendNotice, type SendNotice } from "@/lib/email/notice";
import { sendVerdictEmail } from "@/lib/email/resend";
import { safeErrorText } from "@/lib/errors/safe-error";
import { enqueue } from "@/lib/jobs/queue";
import { recordEvent, transition } from "@/lib/reports/lifecycle";
import { repositoryMentions } from "@/lib/targets/suggest";
import type { TrueForgeClient } from "@/lib/trueforge/client";

import { findDuplicateCandidates, type DuplicateCandidate } from "./duplicates";
import { runEmailTriage, type EmailTriage } from "./email-triage";

/**
 * The NEEDS_DECISION gate for an outside email report.
 *
 * Intake creates the report in NEEDS_DECISION and the worker calls holdForDecision, which sends
 * the fixed acknowledgement, runs the no-tool triage and records duplicate candidates. None of
 * that clones, builds, provisions or opens an analysis session. From there only a reviewer moves
 * the report, through one of the three actions below, and each one re-checks under a row lock
 * that the report is still waiting, so two reviewers clicking at once cannot both act.
 */
export const TRIAGED_EVENT = "intake.triaged";

export type GateTriage = {
  /** Null when the triage turn failed or its reply did not parse. */
  triage: EmailTriage | null;
  /** github.com owner/repo mentions read from the body by pattern, not by the model. */
  linkedRepositories: string[];
  duplicateCandidates: DuplicateCandidate[];
};

export type GateResult = { ok: true } | { ok: false; reason: string };

/** The job payload that releases a gated report into the normal analysis-only run. */
export type GateAnalysisPayload = { intake: "gate-analysis"; reportId: string };

async function hasEvent(reportId: string, type: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sessionEvent.id })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.reportId, reportId), eq(sessionEvent.type, type)))
    .limit(1);
  return Boolean(row);
}

/**
 * The worker's step for an outside report. Safe to run again after a crash: the acknowledgement
 * and the triage are each recorded once, and a rerun skips what is already on the trail. A
 * transient Resend failure throws so the job retries; the triage itself never throws.
 */
export async function holdForDecision(
  reportId: string,
  signal: AbortSignal,
  deps: { client: TrueForgeClient; send?: SendNotice },
): Promise<void> {
  const [row] = await db
    .select({ title: report.title, body: report.body, state: report.state })
    .from(report)
    .where(eq(report.id, reportId))
    .limit(1);
  if (!row) throw new Error(`report ${reportId} does not exist`);

  const ack = await sendNotice(reportId, "acknowledgement", deps.send ?? sendVerdictEmail, signal);
  if (ack.status === "refused") {
    await recordEvent(
      reportId,
      "intake.acknowledgement_refused",
      { reason: ack.reason },
      { idempotencyKey: "intake.acknowledgement_refused" },
    );
  }

  // A reviewer can decide before the triage finishes. Then there is nobody left to advise.
  if (row.state !== "NEEDS_DECISION" || (await hasEvent(reportId, TRIAGED_EVENT))) return;

  const triage = await runEmailTriage(deps.client, { title: row.title, body: row.body }, { signal });
  const record: GateTriage = {
    triage,
    linkedRepositories: repositoryMentions(row.body),
    duplicateCandidates: await findDuplicateCandidates(reportId, row.title, row.body),
  };
  await recordEvent(reportId, TRIAGED_EVENT, record, { idempotencyKey: TRIAGED_EVENT });
}

export type GateView = {
  triage: GateTriage | null;
  duplicateOf: { id: string; title: string } | null;
  duplicateReplySent: boolean;
  verifiedSender: string | null;
};

/** What the case file shows for a gated or gate-closed report. */
export async function readGate(reportId: string): Promise<GateView> {
  const [row] = await db
    .select({ duplicateOfReportId: report.duplicateOfReportId, verifiedSender: report.verifiedSender })
    .from(report)
    .where(eq(report.id, reportId))
    .limit(1);
  const [event] = await db
    .select({ data: sessionEvent.data })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.reportId, reportId), eq(sessionEvent.type, TRIAGED_EVENT)))
    .orderBy(desc(sessionEvent.seq))
    .limit(1);

  let duplicateOf: GateView["duplicateOf"] = null;
  if (row?.duplicateOfReportId) {
    const [original] = await db
      .select({ id: report.id, title: report.title })
      .from(report)
      .where(eq(report.id, row.duplicateOfReportId))
      .limit(1);
    duplicateOf = original ?? null;
  }

  return {
    triage: (event?.data as GateTriage | undefined) ?? null,
    duplicateOf,
    duplicateReplySent: row?.duplicateOfReportId ? await noticeSent(reportId, "duplicate") : false,
    verifiedSender: row?.verifiedSender ?? null,
  };
}

/** Lock the report and confirm it is still at the gate. */
async function lockAtGate(tx: Executor, reportId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [row] = await tx
    .select({ state: report.state })
    .from(report)
    .where(eq(report.id, reportId))
    .for("update");
  if (!row) return { ok: false, reason: "report not found" };
  if (row.state !== "NEEDS_DECISION") {
    return { ok: false, reason: `report is ${row.state}; it is no longer waiting for a decision` };
  }
  return { ok: true };
}

/** Reject or mark as spam: close the report and send the reporter nothing. */
export async function rejectAtGate(reportId: string, reviewer: string, spam: boolean): Promise<GateResult> {
  return db.transaction(async (tx) => {
    const gate = await lockAtGate(tx, reportId);
    if (!gate.ok) return gate;
    await transition(reportId, "NEEDS_DECISION", "DENIED", tx);
    await recordEvent(reportId, spam ? "intake.marked_spam" : "intake.rejected", { reviewer }, { tx });
    return { ok: true };
  });
}

/**
 * Run analysis: the same analysis-only run an allowlisted sender's email gets. The report goes
 * back to TRIAGING and a job is queued in the same transaction, so the worker only ever sees a
 * released report. The delivery id is per report, so a double click queues one job.
 */
export async function releaseForAnalysis(reportId: string, reviewer: string): Promise<GateResult> {
  return db.transaction(async (tx) => {
    const gate = await lockAtGate(tx, reportId);
    if (!gate.ok) return gate;
    await transition(reportId, "NEEDS_DECISION", "TRIAGING", tx);
    const payload: GateAnalysisPayload = { intake: "gate-analysis", reportId };
    await enqueue({ channel: "email", deliveryId: `gate-analysis:${reportId}`, payload }, tx);
    await recordEvent(reportId, "intake.analysis_released", { reviewer }, { tx });
    return { ok: true };
  });
}

/**
 * Mark duplicate: link the report to an existing one, close it, and send the fixed duplicate
 * reply. The reviewer's click is the approval of that fixed text; nothing else ever sends it.
 *
 * The close commits before the send, because a mail cannot be taken back and a state change can
 * be retried. If the send fails, calling this again on the closed report sends the reply without
 * closing anything a second time, under the same idempotency key.
 */
export async function markDuplicateAtGate(
  reportId: string,
  duplicateOfId: string,
  reviewer: string,
  send: SendNotice = sendVerdictEmail,
): Promise<GateResult> {
  if (duplicateOfId === reportId) return { ok: false, reason: "a report cannot duplicate itself" };

  const closed = await db.transaction(async (tx): Promise<GateResult> => {
    const [row] = await tx
      .select({ state: report.state, duplicateOfReportId: report.duplicateOfReportId })
      .from(report)
      .where(eq(report.id, reportId))
      .for("update");
    if (!row) return { ok: false, reason: "report not found" };
    // Already closed as this duplicate: only the reply is left to (re)send.
    if (row.state === "DENIED" && row.duplicateOfReportId === duplicateOfId) return { ok: true };

    const gate = await lockAtGate(tx, reportId);
    if (!gate.ok) return gate;

    const [original] = await tx
      .select({ id: report.id, duplicateOfReportId: report.duplicateOfReportId })
      .from(report)
      .where(eq(report.id, duplicateOfId))
      .limit(1);
    if (!original) return { ok: false, reason: "the original report was not found" };
    if (original.duplicateOfReportId) {
      return { ok: false, reason: "that report is itself a duplicate; link the original instead" };
    }

    await tx
      .update(report)
      .set({ duplicateOfReportId: duplicateOfId, updatedAt: new Date() })
      .where(eq(report.id, reportId));
    await transition(reportId, "NEEDS_DECISION", "DENIED", tx);
    await recordEvent(reportId, "intake.marked_duplicate", { reviewer, duplicateOf: duplicateOfId }, { tx });
    return { ok: true };
  });
  if (!closed.ok) return closed;

  try {
    const reply = await sendNotice(reportId, "duplicate", send);
    if (reply.status === "refused") {
      return { ok: false, reason: `Closed as a duplicate, but the reply was not sent: ${reply.reason}` };
    }
  } catch (error) {
    return {
      ok: false,
      reason: `Closed as a duplicate, but the reply did not send (${safeErrorText(error, 120)}). Try sending it again.`,
    };
  }
  return { ok: true };
}
