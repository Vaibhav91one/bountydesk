import { and, db, eq, outboundDelivery, report, sql } from "@/lib/db";
import { isVerifiedEmailRecipient } from "@/lib/email/recipient";
import { EMAIL_ASSET_ORIGIN, ResendSendError } from "@/lib/email/resend";
import { renderVerdictEmail } from "@/lib/email/markup";

import type { DeliveryArm } from "./arm";
import { LeaseLostError, runWithHeartbeat } from "./queue";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Resend keeps an idempotency key for 24 hours. Inside that window a retry is provably the same
 * send; outside it, a retry could put a second copy of the verdict in someone's inbox and nothing
 * can tell us whether the first one went. The margin is deliberate: eight attempts with backoff
 * capped at five minutes never comes close, so crossing this line means the worker fleet was
 * stopped for most of a day, and a human should look rather than a machine guess.
 */
const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;

/** Subject lines are reporter-controlled, and a bare CR or LF in a header is header injection. */
export function emailSubject(title: string): string {
  const cleaned = title.replace(/[\r\n]+/g, " ").trim().slice(0, 180);
  return `Re: ${cleaned || "your report"}`;
}

/**
 * Render the approved payload as an HTML part.
 *
 * The payload is markdown and is laid out as markdown: headings, findings with a severity chip,
 * lists and code. It carries agent-authored text that can echo prompt-injection content off an
 * untrusted target, and the renderer in lib/email/markup.ts emits every raw-markup node as
 * escaped text, so nothing the agent wrote can become live markup in a mailbox that sanitises
 * nothing. The one deliberate
 * exception is the delivery marker, put back as a real comment so an audit can count it.
 */
export function emailHtml(payload: string, verdictId: string): string {
  return renderVerdictEmail(payload, verdictId, EMAIL_ASSET_ORIGIN);
}

/**
 * Thread the reply onto the message the reporter sent, so it lands in the same conversation.
 * `source_ref` is `email:<rfc-message-id>`; anything that is not already angle-bracketed is left
 * alone rather than synthesised, because a wrong Message-ID is worse than none.
 */
export function threadingHeaders(sourceRef: string): Record<string, string> | undefined {
  const messageId = sourceRef.startsWith("email:") ? sourceRef.slice("email:".length) : "";
  if (!messageId.startsWith("<") || !messageId.endsWith(">")) return undefined;
  return { "In-Reply-To": messageId, References: messageId };
}

/**
 * Mail the verdict to the reporter.
 *
 * Two things make a retry safe here, because unlike GitHub there is no mailbox to read back.
 * First, `provider_message_id` is written the moment a send returns, so a claim that finds it
 * already set knows bytes went out and never sends again. Second, Resend's idempotency key covers
 * the gap between the provider accepting and that write committing. Both depend on the request
 * being byte-identical across attempts, which is why every field below is a pure function of the
 * approved payload and the report's own columns: a timestamp here would turn a safe replay into a
 * refused mismatch.
 */
export const emailArm: DeliveryArm = async (ctx, deps) => {
  const { lease } = ctx;

  const to = ctx.report.reporterContact?.trim().toLowerCase() ?? "";
  if (!to || !EMAIL_SHAPE.test(to)) {
    return {
      kind: "refused",
      message: `report ${ctx.report.id} has no verified reporter contact to deliver to`,
    };
  }

  // The destination is frozen at approval: a human approved sending these bytes to that address.
  // If the report's contact has moved since, this is not the delivery that was approved.
  if (lease.target !== to) {
    return {
      kind: "refused",
      message: `delivery ${lease.id} target does not match report ${ctx.report.id}`,
    };
  }

  // The email analogue of the GitHub grant re-check: authorization is re-read at send time, not
  // trusted from approval time. An address removed from the allowlist in between must not be
  // sent report contents, and an outside sender qualifies only while the report still records
  // this exact address as the one that passed SPF and DKIM at intake. The verified sender is
  // read here rather than carried in the context, so the check is against the row as it is now.
  const [recipient] = await db
    .select({ verifiedSender: report.verifiedSender })
    .from(report)
    .where(eq(report.id, ctx.report.id))
    .limit(1);
  if (
    !(await isVerifiedEmailRecipient({
      reporterContact: to,
      verifiedSender: recipient?.verifiedSender ?? null,
    }))
  ) {
    return {
      kind: "refused",
      message: `${to} is no longer an authorised recipient; a human has to re-authorise it`,
      hold: true,
    };
  }

  const [row] = await db
    .select({
      providerMessageId: outboundDelivery.providerMessageId,
      createdAt: outboundDelivery.createdAt,
    })
    .from(outboundDelivery)
    .where(eq(outboundDelivery.id, lease.id))
    .limit(1);

  if (row?.providerMessageId) {
    return {
      kind: "replayed",
      note: `already sent as ${row.providerMessageId}; no second mail`,
      completesReport: false,
    };
  }

  if (row && Date.now() - row.createdAt.getTime() > IDEMPOTENCY_WINDOW_MS) {
    return {
      kind: "refused",
      message:
        "cannot prove no earlier send went out: the provider's idempotency window has expired, so a retry risks mailing the reporter twice",
      hold: true,
    };
  }

  let sent: { id: string };
  try {
    sent = await runWithHeartbeat(
      lease,
      ctx.leaseSeconds,
      (signal) =>
        deps.sendEmail({
          to,
          subject: emailSubject(ctx.report.title),
          text: ctx.payload,
          html: emailHtml(ctx.payload, lease.verdictId),
          idempotencyKey: lease.idempotencyKey,
          headers: threadingHeaders(ctx.report.sourceRef),
          signal,
        }),
      ctx.signal,
    );
  } catch (error) {
    if (error instanceof ResendSendError && error.disposition !== "transient") {
      // Nothing retries a non-transient refusal, and the report stays in DELIVERING either way,
      // so a human has to see it. A mismatch means the key already carried different bytes; a
      // permanent error can also be a send that went out but came back unidentifiable. Neither
      // is safe to reissue under a fresh key.
      return { kind: "refused", message: error.message, hold: true };
    }
    throw error;
  }

  // Written before the attempt is recorded and under the lease fence, so a worker that lost its
  // lease cannot stamp a row another worker now owns. If this write is the thing that dies, the
  // idempotency key still makes the next attempt a replay rather than a second mail.
  const stamped = await db
    .update(outboundDelivery)
    .set({ providerMessageId: sent.id, updatedAt: new Date() })
    .where(
      and(
        eq(outboundDelivery.id, lease.id),
        eq(outboundDelivery.leaseOwner, lease.leaseOwner),
        eq(outboundDelivery.fence, lease.fence),
        sql`${outboundDelivery.leaseExpiresAt} > now()`,
      ),
    )
    .returning({ id: outboundDelivery.id });
  if (stamped.length === 0) throw new LeaseLostError(lease.id);

  // Accepted by the provider, which is not yet delivered. The report stays DELIVERING until the
  // delivered webhook arrives; see ArmOutcome.completesReport.
  return {
    kind: "sent",
    responseStatus: 200,
    responseBody: JSON.stringify({ id: sent.id }),
    completesReport: false,
  };
};
