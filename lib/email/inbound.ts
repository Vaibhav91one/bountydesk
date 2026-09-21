import { Webhook } from "svix";

import { requireSecret } from "@/lib/env";

/** The Svix headers Resend signs every webhook with. */
export type SvixHeaders = {
  "svix-id": string;
  "svix-timestamp": string;
  "svix-signature": string;
};

export type ResendWebhookEvent = {
  type: string;
  data: Record<string, unknown>;
};

/**
 * Verify the Svix signature Resend puts on every webhook and return the parsed event. Throws on a
 * missing header, a bad signature, or a stale timestamp, so an unsigned or forged delivery never
 * reaches the parser. The raw request body must be passed unmodified: re-serializing it changes the
 * bytes the signature was computed over.
 */
export function verifyResendWebhook(rawBody: string, headers: SvixHeaders): ResendWebhookEvent {
  const webhook = new Webhook(requireSecret("RESEND_WEBHOOK_SECRET"));
  // svix's verify throws on a bad signature or stale timestamp and returns nothing, so the body is
  // trusted to parse only after it returns.
  webhook.verify(rawBody, headers);
  return JSON.parse(rawBody) as ResendWebhookEvent;
}

export type InboundEmail = {
  /** The provider message id, used as the report's idempotency key and delivery id. */
  messageId: string;
  /** The verified sender address, lowercased. This is the reply-to for a future outbound delivery. */
  fromEmail: string;
  /** A display name if the From header carried one. */
  fromName: string | null;
  subject: string;
  text: string;
};

const ADDRESS_IN_ANGLE_BRACKETS = /<([^>]+)>/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Split a From value that may be "Name <email@host>", a bare address, or a {name,address} object. */
function parseFrom(from: unknown): { email: string | null; name: string | null } {
  if (from && typeof from === "object") {
    const record = from as Record<string, unknown>;
    const email = typeof record.address === "string" ? record.address : null;
    const name = typeof record.name === "string" ? record.name : null;
    return { email: email?.toLowerCase() ?? null, name: name || null };
  }
  if (typeof from !== "string") return { email: null, name: null };

  const angle = from.match(ADDRESS_IN_ANGLE_BRACKETS);
  if (angle) {
    const name = from.slice(0, angle.index).trim().replace(/^"|"$/g, "");
    return { email: angle[1].trim().toLowerCase(), name: name || null };
  }
  const trimmed = from.trim().toLowerCase();
  return { email: EMAIL_SHAPE.test(trimmed) ? trimmed : null, name: null };
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.length > 0) return value;
  return "";
}

/**
 * Normalize an `email.received` event into the fields intake needs. Returns null when the sender or
 * a message id cannot be read, because a report with no verified reply-to and no idempotency key is
 * not worth creating. Tolerant of shape drift: providers move fields around, and a dropped email is
 * better than a crash on the webhook.
 */
export function parseInboundEmail(event: ResendWebhookEvent): InboundEmail | null {
  if (event.type !== "email.received") return null;

  const data = event.data ?? {};
  const { email, name } = parseFrom(data.from);
  if (!email) return null;

  const messageId = firstString(data.message_id, data.messageId, data.id, data.email_id);
  if (!messageId) return null;

  return {
    messageId,
    fromEmail: email,
    fromName: name,
    subject: firstString(data.subject) || "(no subject)",
    text: firstString(data.text, data.html),
  };
}
