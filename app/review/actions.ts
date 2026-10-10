"use server";

import { requireWriteAccess } from "@/lib/auth/dal";
import { decide, revalidateReportViews, type ActionResult } from "@/lib/review/decide";
import { enqueueCodeReview, loadCodeReviewInput } from "@/lib/analysis/code-review";
import { resolveAppeal } from "@/lib/appeals/appeals";
import { deliverById } from "@/lib/delivery/worker";
import { requestOwnerAdvisory } from "@/lib/delivery/advisory";
import { cancelHeldReport, retryHeldDelivery } from "@/lib/delivery/retry";
import { startRetest } from "@/lib/retests/retest";
import {
  cancelRecheck,
  requestRecheck,
  retryRecheck,
} from "@/lib/investigation-runs/recheck";
import {
  composeRecheckGuidance,
  MAX_RECHECK_NOTE_LENGTH,
} from "@/lib/investigation-runs/recheck-guidance";
import { isReportId } from "@/lib/reports/case";
import { resolveReportId } from "@/app/(app)/reports/[id]/resolve-id";
import { bindTarget } from "@/lib/targets/bind";
import type { Ecosystem } from "@/lib/build-onboarding/build-plan";
import { approveUploadTarget } from "@/lib/upload/gate";
import { admitReviewerUpload, parseUploadForm } from "@/lib/upload/intake";
import { readOutsideConfig } from "@/lib/email/outside-config";
import { RUN_NOT_FOUND, thrownActionError } from "@/lib/review/action-errors";
import { safeErrorText } from "@/lib/errors/safe-error";
import {
  denyAtGate,
  markDuplicateAtGate,
  rejectAtGate,
  releaseForAnalysis,
  type GateResult,
} from "@/lib/triage/gate";

export type { ActionResult };

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
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  const session = access.session;
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
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  const session = access.session;
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
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  const session = access.session;
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
 * Start a fix-verification retest of a REPRODUCED report at a commit the reviewer names. The
 * retest runs as a separate child report, so this never edits the original report or its target,
 * and the child's verdict is never delivered (it has no reporter contact).
 */
export async function requestRetestAction(
  reportId: string,
  commitSha: string,
): Promise<ActionResult & { childReportId?: string }> {
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  // A server action is callable with any JSON, so the types are checked here.
  if (typeof reportId !== "string" || !isReportId(reportId) || typeof commitSha !== "string") {
    return { ok: false, error: "That report or commit is not valid." };
  }
  try {
    const result = await startRetest(reportId, commitSha.trim(), { login: access.session.login });
    revalidateReportViews(reportId);
    return result.ok ? { ok: true, childReportId: result.childReportId } : { ok: false, error: result.reason };
  } catch (error) {
    return thrownActionError(error, "retest");
  }
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
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  const session = access.session;
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
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  const session = access.session;
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

/**
 * Re-queue the report's held delivery once the cause is fixed (a permission accepted, a recipient
 * re-authorised, a repository reconnected). The row keeps its approved hash, target and delivery
 * marker, and the send runs every gate again, so this chooses when to try, never what is sent.
 */
export async function retryHeldDeliveryAction(reportId: string): Promise<ActionResult> {
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  const session = access.session;
  if (!isReportId(reportId)) return { ok: false, error: "That report is not valid." };
  let deliveryId: string;
  try {
    const result = await retryHeldDelivery(reportId, session.login);
    if (!result.ok) return { ok: false, error: result.reason };
    deliveryId = result.deliveryId;
  } catch (error) {
    return thrownActionError(error, "redeliver");
  }
  // Best effort, like an approval's immediate post: the row is queued either way, and the worker's
  // drain picks it up if this attempt does not finish it.
  try {
    await deliverById(deliveryId, `review-retry-delivery-${deliveryId}`, { leaseSeconds: 20 });
  } catch (error) {
    console.error(`delivery ${deliveryId}: immediate retry failed: ${safeErrorText(error)}`);
  }
  revalidateReportViews(reportId);
  return { ok: true };
}

/**
 * Close a report stuck in DELIVERING behind a delivery that is held and can never send. This moves
 * the report to CANCELLED and nothing else: the held outbox row is already unreachable, so there is
 * no send to cancel, and nothing goes to the reporter.
 */
export async function cancelReportAction(reportId: string): Promise<ActionResult> {
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  const session = access.session;
  if (!isReportId(reportId)) return { ok: false, error: "That report is not valid." };
  try {
    const result = await cancelHeldReport(reportId, session.login);
    if (!result.ok) return { ok: false, error: result.reason };
    revalidateReportViews(reportId);
    return { ok: true };
  } catch (error) {
    return thrownActionError(error, "cancel-report");
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
 * Reject an outside report at the NEEDS_DECISION gate, or mark it as spam. Both close it as DENIED.
 * A reject sends the reporter the fixed out-of-scope reply; spam stays silent. gateDecision surfaces
 * the reason rejectAtGate returns, so a close that committed but whose reply failed reports that
 * partial state rather than the generic failure message.
 */
export async function rejectAtGateAction(reportId: string, spam: boolean): Promise<ActionResult> {
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  const session = access.session;
  return gateDecision(reportId, () => rejectAtGate(reportId, session.login, spam === true));
}

/** Release an outside report from the gate into the normal analysis-only run. */
export async function runAnalysisAction(reportId: string): Promise<ActionResult> {
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  const session = access.session;
  return gateDecision(reportId, () => releaseForAnalysis(reportId, session.login));
}

/**
 * Dismiss a gated advisory or upload report: close it as denied and send nothing. An upload's
 * contact may be unproven, so it gets no canned reply either.
 */
export async function dismissAdvisoryAction(reportId: string): Promise<ActionResult> {
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  const session = access.session;
  return gateDecision(reportId, () => denyAtGate(reportId, session.login));
}

/**
 * Release an upload report and queue its target material for a build, with the target settings the
 * reviewer approved. The settings are validated server-side into a target definition; the build and
 * the analysis run happen on the worker.
 */
export async function approveUploadTargetAction(
  reportId: string,
  input: { port: number; readinessPath: string; startCommand?: string; ecosystem?: string },
): Promise<ActionResult> {
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  const session = access.session;
  return gateDecision(reportId, () =>
    approveUploadTarget(reportId, session.login, {
      port: Number(input.port),
      readinessPath: String(input.readinessPath ?? ""),
      ...(input.startCommand ? { startCommand: String(input.startCommand) } : {}),
      ...(input.ecosystem ? { ecosystem: input.ecosystem as Ecosystem } : {}),
    }),
  );
}

/**
 * Accept a target an authenticated reviewer uploaded from the dashboard, and queue its build.
 *
 * The trust boundary is this one line: requireWriteAccess runs first, so a signed-out,
 * non-allowlisted, or read-only caller is turned away before any bytes are read, and the contact
 * is overwritten with the reviewer's own session email rather than taken from the form. That is
 * what lets this path skip the public OTP the anonymous /submit route needs: the reviewer's
 * address is already proven by their session, so no code round trip is used to prove it again.
 *
 * Everything downstream is unchanged. The material is validated by parseUploadForm, the same
 * validator the public route runs, so the size caps, tarball check and image-registry allowlist
 * hold identically. The build and reproduction still run in the offline sandboxes, and the drafted
 * verdict still waits for a human at publish_verdict: uploading a target is not approving its
 * verdict.
 */
export async function submitReviewerUploadAction(
  formData: FormData,
): Promise<ActionResult & { reportId?: string }> {
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  const session = access.session;
  // The contact is the authenticated reviewer, never a value the form supplied. Overwriting it
  // here is what binds the upload's delivery address to the signed-in identity.
  formData.set("contact", session.email);

  const config = await readOutsideConfig();
  const parsed = await parseUploadForm(formData, config);
  if (!parsed.ok) return { ok: false, error: parsed.reason };

  const startCommand = String(formData.get("startCommand") ?? "").trim();
  const ecosystem = String(formData.get("ecosystem") ?? "").trim();
  const target = {
    port: Number(formData.get("port")),
    readinessPath: String(formData.get("readinessPath") ?? ""),
    ...(startCommand ? { startCommand } : {}),
    ...(ecosystem ? { ecosystem: ecosystem as Ecosystem } : {}),
  };

  try {
    const result = await admitReviewerUpload(parsed.submission, session, target);
    if (!result.ok) return { ok: false, error: result.reason };
    revalidateReportViews(result.reportId);
    return { ok: true, reportId: result.reportId };
  } catch (error) {
    console.error(`reviewer upload for ${session.login} failed: ${safeErrorText(error)}`);
    return { ok: false, error: "The upload could not be accepted." };
  }
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
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  const session = access.session;
  // Accept the short id printed on a case file (`#725dcfed`), not just the full uuid: a reviewer
  // pastes what they can see. A prefix that names no report, or more than one, is refused here.
  const resolved = await resolveReportId(duplicateOfId);
  if (!resolved) return { ok: false, error: "That is not a report id." };
  return gateDecision(reportId, () => markDuplicateAtGate(reportId, resolved, session.login));
}

export async function retryRecheckAction(reportId: string, runId: string): Promise<ActionResult> {
  const access = await requireWriteAccess();
  if (!access.ok) return access;
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
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  if (!isReportId(reportId) || !isReportId(runId)) return { ok: false, error: RUN_NOT_FOUND };
  try {
    const result = await cancelRecheck(reportId, runId);
    revalidateReportViews(reportId);
    return result;
  } catch (error) {
    return thrownActionError(error, "cancel");
  }
}

/**
 * Queue the read-only code review for a report. The worker daemon runs it, because the turn polls
 * for minutes and would outlive a request. It records findings as evidence and touches no report
 * state, reproduction or verdict. A report with no connected repository has no source to read.
 */
export async function runCodeReviewAction(reportId: string): Promise<ActionResult> {
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  if (!isReportId(reportId)) return { ok: false, error: "The report id is not valid." };
  if (!(await loadCodeReviewInput(reportId))) {
    return { ok: false, error: "This report has no connected repository to review." };
  }
  await enqueueCodeReview(reportId);
  revalidateReportViews(reportId);
  return { ok: true };
}

/**
 * Acknowledge or close a reporter's appeal. This only records status and an optional note: the
 * report is DELIVERED, so the recheck above cannot revise its verdict.
 */
export async function resolveAppealAction(
  reportId: string,
  appealId: string,
  action: "acknowledge" | "close",
  note?: string,
): Promise<ActionResult> {
  const access = await requireWriteAccess();
  if (!access.ok) return access;
  if (!isReportId(reportId) || !isReportId(appealId)) return { ok: false, error: "That appeal is not valid." };
  if (action !== "acknowledge" && action !== "close") return { ok: false, error: "That action is not valid." };
  if (note !== undefined && typeof note !== "string") return { ok: false, error: "The note is not valid." };
  try {
    const result = await resolveAppeal(reportId, appealId, action, access.session, note);
    revalidateReportViews(reportId);
    return result;
  } catch (error) {
    console.error(`resolving appeal ${appealId} failed: ${safeErrorText(error)}`);
    return { ok: false, error: "Could not update the appeal." };
  }
}
