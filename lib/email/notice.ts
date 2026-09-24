import { and, db, eq, report, sessionEvent } from "@/lib/db";
import { threadingHeaders } from "@/lib/delivery/email";
import { recordEventLocked } from "@/lib/reports/lifecycle";

import { ResendSendError, sendVerdictEmail } from "./resend";

/**
 * The two fixed messages an outside reporter can receive without a verdict behind them.
 *
 * Neither carries a byte of the report, the triage or another report: an acknowledgement goes out
 * before any human has looked, and a duplicate reply must not tell one reporter about another's
 * submission. Both are constants, so what a reviewer's click on "Mark duplicate" approves is
 * exactly the text below, and the idempotency key can safely cover a retry.
 */
export const NOTICES = {
  acknowledgement: {
    subject: "We received your report",
    text: [
      "Thank you for your report. We have received it, and a person will look at it.",
      "",
      "You do not need to do anything else for now. If we need more from you, or once there is an outcome, we will reply to this address.",
      "",
      "BountyDesk",
    ].join("\n"),
  },
  duplicate: {
    subject: "Your report duplicates an existing report",
    text: [
      "Thank you for your report. A reviewer has looked at it and found that it describes an issue already reported to us, so we have closed it as a duplicate of an existing report.",
      "",
      "If you believe this is a different issue, reply with what distinguishes it.",
      "",
      "BountyDesk",
    ].join("\n"),
  },
} as const;

export type NoticeKind = keyof typeof NOTICES;

export type NoticeResult =
  | { status: "sent"; providerMessageId: string }
  | { status: "already-sent" }
  | { status: "refused"; reason: string };

export type SendNotice = typeof sendVerdictEmail;

function sentEventType(kind: NoticeKind): string {
  return `intake.${kind}_sent`;
}

/** Whether this notice already went out for the report, read from the audit trail. */
export async function noticeSent(reportId: string, kind: NoticeKind): Promise<boolean> {
  const [row] = await db
    .select({ id: sessionEvent.id })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.reportId, reportId), eq(sessionEvent.type, sentEventType(kind))))
    .limit(1);
  return Boolean(row);
}

/**
 * Mail one fixed notice to the report's outside sender, at most once.
 *
 * Only an address intake verified by SPF and DKIM qualifies (contact equal to verified_sender);
 * an allowlisted sender never gets these, because nothing holds their reports at the gate. The
 * audit event is written after the send, so a crash in between retries under the same Resend
 * idempotency key and Resend drops the second copy. A transient provider failure throws for the
 * caller to retry; anything else is returned as refused.
 */
export async function sendNotice(
  reportId: string,
  kind: NoticeKind,
  send: SendNotice = sendVerdictEmail,
  signal?: AbortSignal,
): Promise<NoticeResult> {
  if (await noticeSent(reportId, kind)) return { status: "already-sent" };

  const [row] = await db
    .select({
      channel: report.channel,
      sourceRef: report.sourceRef,
      reporterContact: report.reporterContact,
      verifiedSender: report.verifiedSender,
    })
    .from(report)
    .where(eq(report.id, reportId))
    .limit(1);
  if (!row) return { status: "refused", reason: "report not found" };

  const to = row.reporterContact?.trim().toLowerCase() ?? "";
  const verified = row.verifiedSender?.trim().toLowerCase() ?? "";
  if (row.channel !== "email" || !to || to !== verified) {
    return { status: "refused", reason: "the report has no SPF/DKIM-verified sender to reply to" };
  }

  let sent: { id: string };
  try {
    sent = await send({
      to,
      subject: NOTICES[kind].subject,
      text: NOTICES[kind].text,
      idempotencyKey: `notice:${kind}:${reportId}`,
      headers: threadingHeaders(row.sourceRef),
      signal,
    });
  } catch (error) {
    if (error instanceof ResendSendError && error.disposition !== "transient") {
      return { status: "refused", reason: error.message };
    }
    throw error;
  }

  // Locked: the acknowledgement is written while a reviewer may be deciding at the gate.
  await recordEventLocked(reportId, sentEventType(kind), { providerMessageId: sent.id }, sentEventType(kind));
  return { status: "sent", providerMessageId: sent.id };
}
