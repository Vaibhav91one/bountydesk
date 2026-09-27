import { isReviewerEmail } from "@/lib/auth/reviewers";
import { parseInboundEmail, verifyResendWebhook, type SvixHeaders } from "@/lib/email/inbound";
import { admitOutsideEmail } from "@/lib/email/outside-intake";
import { safeErrorText } from "@/lib/errors/safe-error";
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
 * it stops at analysis only. An outside sender's report stops earlier, at the NEEDS_DECISION
 * gate, until a reviewer decides. Idempotency is the provider message id.
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

  // An allowlisted sender, the same allowlist that authorizes the dashboard, goes straight to the
  // queue and gets the automatic analysis-only run.
  if (await isReviewerEmail(email.fromEmail)) {
    await enqueue({ channel: "email", deliveryId: email.messageId, payload: email });
    return new Response("accepted", { status: 202 });
  }

  // Anyone else has to pass SPF, DKIM, the daily limits and the size cap, and even then the
  // report waits for a human before anything runs on it. A message that fails is dropped with a
  // 202 so Resend stops retrying: no queue row, no report.
  let admission;
  try {
    admission = await admitOutsideEmail(email);
  } catch (error) {
    // The sender could not be checked (Resend unreachable). A 5xx makes Resend redeliver, which
    // is better than dropping a message nobody looked at or accepting one nobody verified.
    console.error(`email intake: could not screen ${email.messageId}: ${safeErrorText(error)}`);
    return new Response("could not verify sender", { status: 503 });
  }
  if (!admission.accepted) {
    console.warn(`email intake: dropped ${email.messageId} from ${email.fromEmail}: ${admission.reason}`);
    return new Response(`ignored: ${admission.reason}`, { status: 202 });
  }
  return new Response("accepted", { status: 202 });
}
