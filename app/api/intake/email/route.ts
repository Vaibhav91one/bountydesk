import { isReviewerEmail } from "@/lib/auth/reviewers";
import { parseInboundEmail, verifyResendWebhook, type SvixHeaders } from "@/lib/email/inbound";
import { applyDeliveryReceipt } from "@/lib/email/receipts";
import { readBoundedBody } from "@/lib/github/webhook";
import { enqueue } from "@/lib/jobs/queue";

/**
 * Every Resend webhook: inbound intake (`email.received`) and the receipts for mail we sent.
 *
 * Same order as the GitHub webhook, and the same security property: read the raw bytes, verify the
 * Svix signature, and only then parse. An unsigned or forged delivery reaches no parser, no queue
 * and no database. A verified message is committed to the jobs table before this returns, so the
 * 202 is a promise kept across a restart; the worker builds the report and, with no bound target,
 * it stops at analysis only. Idempotency is the provider message id.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await readBoundedBody(request);
  if (!raw) return new Response("body too large", { status: 413 });
  const body = raw.toString("utf8");

  const headers: SvixHeaders = {
    "svix-id": request.headers.get("svix-id") ?? "",
    "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
    "svix-signature": request.headers.get("svix-signature") ?? "",
  };

  let event;
  try {
    event = verifyResendWebhook(body, headers);
  } catch {
    return new Response("invalid signature", { status: 401 });
  }

  // Resend signs every event for an endpoint with that endpoint's own secret, so the outbound
  // receipts share this route rather than getting a second one: one endpoint, one secret, one
  // place where verify-before-parse has to be right.
  //
  // The split is on `email.received` alone, which makes it total: one event type is intake and
  // every other type, modelled or not, goes to the receipt handler to be applied or ignored.
  // A partition that named the receipt types instead would leave a third bucket for anything
  // Resend adds later, and that bucket would silently fall through the sender allowlist.
  if (event.type !== "email.received") {
    const result = await applyDeliveryReceipt(event);
    return new Response(result.note, { status: 202 });
  }

  const email = parseInboundEmail(event);
  if (!email) {
    // Signed, but nothing to act on: a non-received event, or a message with no sender or id.
    return new Response(`ignored ${event.type}`, { status: 202 });
  }

  // Only handle mail from an authorized sender. Anyone can email the intake address, and without
  // this gate every stranger's message becomes a report the triage agent runs on. The allowlist is
  // the same one that authorizes the dashboard, checked here on the verified sender. A stranger is
  // dropped, not errored: 202 so Resend stops retrying, no queue row, no triage.
  if (!(await isReviewerEmail(email.fromEmail))) {
    return new Response("ignored: sender not authorized", { status: 202 });
  }

  await enqueue({ channel: "email", deliveryId: email.messageId, payload: email });
  return new Response("accepted", { status: 202 });
}
