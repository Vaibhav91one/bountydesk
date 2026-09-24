import { and, db, eq, report, sessionEvent } from "@/lib/db";
import { emailSubject, threadingHeaders } from "@/lib/delivery/email";
import type { InboundEmail } from "@/lib/email/inbound";
import { recordEventLocked } from "@/lib/reports/lifecycle";

import { ResendSendError, sendVerdictEmail } from "./resend";

/**
 * The fixed messages an outside reporter can receive without a verdict behind them.
 *
 * None carries a byte of the report, the triage or another report: an acknowledgement goes out
 * before any human has looked, a duplicate reply must not tell one reporter about another's
 * submission, and an oversized-drop notice goes out before anything is even queued. Only the body
 * is fixed. The subject is set from the reporter's own subject so the reply threads under their
 * message (see noticeSubject), which is the reporter's own input, not report or triage content.
 * The bodies here are constants, so what a reviewer's click on "Mark duplicate" approves is
 * exactly the text below, and the idempotency key can safely cover a retry. The `subject` field is
 * the fallback used only when the reporter's subject is blank.
 */
export const NOTICES = {
  acknowledgement: {
    subject: "We received your report",
    text: [
      "Thank you for your report. We have received it, and a person will look at it.",
      "",
      "You do not need to do anything else for now. If we need more from you, or if there is an outcome we can share, we will reply to this address.",
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
  oversized: {
    subject: "Your report was too large to accept",
    text: [
      "Thank you for your report. It was larger than we can accept by email, so we were not able to take it in.",
      "",
      "Please send it again with the large evidence linked rather than attached: a link to a file share, a gist, or a repository, with anything sensitive kept access-controlled.",
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

/**
 * The subject for a notice: the reporter's own subject as a reply, so it threads under their
 * message the way a verdict delivery does. emailSubject strips a bare CR or LF (header injection)
 * and truncates, so a reporter-controlled subject is safe here. The fixed subject is a fallback for
 * the case where the reporter sent no subject at all; a report title is not null in practice.
 */
function noticeSubject(kind: NoticeKind, title: string): string {
  return title.trim() ? emailSubject(title) : NOTICES[kind].subject;
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
      title: report.title,
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
      subject: noticeSubject(kind, row.title),
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

/**
 * Tell a verified outside sender that their oversized message was dropped, at most once.
 *
 * An oversized message is refused before any job or report exists, so this cannot key off the
 * audit trail the way sendNotice does: there is no report id to write against. Resend's idempotency
 * key, held for 24 hours, is what stops a webhook redelivery from mailing the sender a second copy,
 * the same margin the verdict delivery relies on. The caller must have already confirmed SPF, DKIM
 * and From alignment before calling this: the address is only safe to mail because the receiving MX
 * authenticated it, so a forged oversized message cannot be turned into mail to an arbitrary
 * address. A transient provider failure throws for the caller to retry; anything else is refused.
 */
export async function sendOversizedNotice(
  email: Pick<InboundEmail, "messageId" | "fromEmail" | "subject">,
  send: SendNotice = sendVerdictEmail,
  signal?: AbortSignal,
): Promise<NoticeResult> {
  const to = email.fromEmail.trim().toLowerCase();
  if (!to) return { status: "refused", reason: "no verified sender to reply to" };

  try {
    const sent = await send({
      to,
      subject: email.subject.trim() ? emailSubject(email.subject) : NOTICES.oversized.subject,
      text: NOTICES.oversized.text,
      idempotencyKey: `notice:oversized:${email.messageId}`,
      headers: threadingHeaders(`email:${email.messageId}`),
      signal,
    });
    return { status: "sent", providerMessageId: sent.id };
  } catch (error) {
    if (error instanceof ResendSendError && error.disposition !== "transient") {
      return { status: "refused", reason: error.message };
    }
    throw error;
  }
}
