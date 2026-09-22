import { requireSecret } from "@/lib/env";

const RESEND_API = "https://api.resend.com";

export type InboundBody = {
  text: string;
  html: string;
};

/**
 * Fetch the body of a received email from Resend.
 *
 * The `email.received` webhook carries the metadata (from, subject, message id) but not the
 * body, so the report body has to be pulled separately. This is called from the worker rather
 * than the intake route: the route stays a fast verify-and-enqueue, and a fetch failure retries
 * with the durable job instead of depending on Resend redelivering the webhook.
 *
 * A non-2xx response throws, so the worker treats a transient Resend outage as a retryable job
 * failure. The explicit User-Agent is not decoration: Resend's edge (Cloudflare) rejects a
 * request with no recognizable agent with a 1010 block before it reaches the API.
 */
export async function fetchInboundBody(resendEmailId: string): Promise<InboundBody> {
  let response: Response;
  try {
    response = await fetch(`${RESEND_API}/emails/receiving/${resendEmailId}`, {
      headers: {
        authorization: `Bearer ${requireSecret("RESEND_API_KEY")}`,
        "user-agent": "bountydesk-worker",
      },
    });
  } catch (cause) {
    // A network-level failure (DNS, connection reset) rejects here rather than returning a
    // response. Rethrow with the same context as the non-2xx path so the retry the worker takes
    // is legible in the logs instead of a bare "fetch failed".
    throw new Error(`resend receiving fetch for ${resendEmailId} failed to connect`, { cause });
  }

  if (!response.ok) {
    throw new Error(
      `resend receiving fetch for ${resendEmailId} failed: ${response.status} ${response.statusText}`,
    );
  }

  let payload: { text?: unknown; html?: unknown };
  try {
    payload = (await response.json()) as { text?: unknown; html?: unknown };
  } catch (cause) {
    // A 2xx with a body that is not JSON should not surface as a bare SyntaxError. Same context as
    // the other failure paths so the worker's retry is legible.
    throw new Error(`resend receiving fetch for ${resendEmailId} returned unparseable JSON`, { cause });
  }
  return {
    text: typeof payload.text === "string" ? payload.text : "",
    html: typeof payload.html === "string" ? payload.html : "",
  };
}
