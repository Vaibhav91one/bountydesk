import { db, eq, outboundDelivery, report, sql } from "@/lib/db";
import { recordEvent, ReportStateConflictError, transition } from "@/lib/reports/lifecycle";

import type { ResendWebhookEvent } from "./inbound";

/**
 * What a delivery event tells us to do with the outbox row and the report.
 *
 * The split matters. `email.sent` is Resend accepting the API call, which the worker already
 * knew; it is not a receipt and must never reach DELIVERED. `email.delivered` is the receiving
 * server accepting the message, and it is the only event that completes a report. A bounce or a
 * failure arrives instead of delivered, never after it, so it is safe to treat as terminal for
 * that send. A complaint arrives after a real delivery, so it flags the row and leaves the
 * report alone.
 */
const OUTCOMES = {
  "email.delivered": { delivered: true, hold: false },
  "email.bounced": { delivered: false, hold: true },
  "email.failed": { delivered: false, hold: true },
  "email.complained": { delivered: false, hold: true },
  "email.sent": { delivered: false, hold: false },
  "email.delivery_delayed": { delivered: false, hold: false },
} as const satisfies Record<string, { delivered: boolean; hold: boolean }>;

export type DeliveryEventType = keyof typeof OUTCOMES;

function isModelled(type: string): type is DeliveryEventType {
  return Object.hasOwn(OUTCOMES, type);
}

/** The provider's id for the message, which is what `provider_message_id` was stamped with. */
function emailId(event: ResendWebhookEvent): string {
  const data = event.data ?? {};
  for (const value of [data.email_id, data.id]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/** Whatever the provider said went wrong, trimmed to something an operator can read in a list. */
function reasonOf(event: ResendWebhookEvent): string | null {
  const data = event.data ?? {};
  const bounce = data.bounce;
  if (bounce && typeof bounce === "object") {
    const record = bounce as Record<string, unknown>;
    const parts = [record.type, record.subType, record.message].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    if (parts.length) return parts.join(" / ").slice(0, 500);
  }
  if (typeof data.reason === "string" && data.reason.length > 0) return data.reason.slice(0, 500);
  return null;
}

export type ReceiptResult =
  | { handled: true; reportId: string; note: string }
  | { handled: false; note: string };

/**
 * Apply an outbound Resend event to the delivery it belongs to.
 *
 * Idempotent three ways, because a provider retries and Svix replays: `recordEvent` is keyed on
 * `resend:<type>:<email_id>` against the unique `(report_id, event_key)`, `transition` is a
 * compare-and-swap that matches nothing the second time, and the hold is a set rather than an
 * increment. Safe to run twice, and safe to run out of order.
 *
 * No `delivery_attempt` row is written here. That table is append-only and its attempt number
 * belongs to the worker's lease; a webhook has no lease and no attempt of its own.
 */
export async function applyDeliveryReceipt(event: ResendWebhookEvent): Promise<ReceiptResult> {
  // Everything that is not `email.received` arrives here, including events this codebase has
  // no opinion about (`email.opened`, a type Resend adds next year, a webhook subscribed by
  // mistake). Ignoring them here rather than at the caller is what keeps the split total: an
  // event is either intake or it is this, and nothing falls between the two.
  if (!isModelled(event.type)) return { handled: false, note: `ignored ${event.type}` };

  const providerMessageId = emailId(event);
  if (!providerMessageId) return { handled: false, note: `${event.type} carried no email id` };

  const [row] = await db
    .select({
      id: outboundDelivery.id,
      reportId: outboundDelivery.reportId,
      state: outboundDelivery.state,
      reportState: report.state,
    })
    .from(outboundDelivery)
    .innerJoin(report, eq(report.id, outboundDelivery.reportId))
    .where(eq(outboundDelivery.providerMessageId, providerMessageId))
    .limit(1);

  // A message we did not send, or one whose id write lost its race with the provider's webhook.
  // Either way there is nothing to correlate, and 202 stops the provider retrying a mystery.
  if (!row) return { handled: false, note: `no delivery for ${providerMessageId}` };

  const outcome = OUTCOMES[event.type];
  const reason = reasonOf(event);

  await recordEvent(
    row.reportId,
    `delivery.${event.type.replace(/^email\./, "")}`,
    { providerMessageId, deliveryId: row.id, ...(reason ? { reason } : {}) },
    { idempotencyKey: `resend:${event.type}:${providerMessageId}` },
  );

  if (outcome.hold) {
    await db
      .update(outboundDelivery)
      .set({
        // A bounce means the bytes never landed, so the row is not SENT any more. A complaint
        // means they did land, so its state is left alone and only the flag is set.
        ...(event.type === "email.complained" ? {} : { state: "FAILED" as const }),
        requiresHumanReview: true,
        lastError: reason ?? event.type,
        updatedAt: new Date(),
      })
      .where(eq(outboundDelivery.id, row.id));
    return { handled: true, reportId: row.reportId, note: `${event.type} held for review` };
  }

  if (!outcome.delivered) {
    return { handled: true, reportId: row.reportId, note: `${event.type} recorded` };
  }

  // The receipt only completes a report that is still waiting for one. A report already
  // DELIVERED (a replayed webhook) or moved on by a human is left where it is: transition's
  // compare-and-swap would refuse anyway, and an exception here would make the provider retry.
  if (row.reportState !== "DELIVERING") {
    return {
      handled: true,
      reportId: row.reportId,
      note: `report is ${row.reportState}; delivered receipt recorded only`,
    };
  }

  await db
    .update(outboundDelivery)
    .set({ deliveredAt: sql`coalesce(${outboundDelivery.deliveredAt}, now())`, updatedAt: new Date() })
    .where(eq(outboundDelivery.id, row.id));

  try {
    await transition(row.reportId, "DELIVERING", "DELIVERED");
  } catch (error) {
    // Two copies of the same webhook can read DELIVERING and race here. The compare-and-swap
    // means only one wins, and the loser has nothing left to do: the report is already where
    // the receipt wanted it. Throwing would make the provider retry a finished delivery.
    if (!(error instanceof ReportStateConflictError)) throw error;
    return { handled: true, reportId: row.reportId, note: "already delivered" };
  }

  return { handled: true, reportId: row.reportId, note: "delivered" };
}
