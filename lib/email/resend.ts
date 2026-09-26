import { requireSecret } from "@/lib/env";

const RESEND_API = "https://api.resend.com";

/**
 * Every Resend fetch carries a signal, and not only as a timeout. Inside a Next.js route, fetch
 * dedupes a signal-less GET by tee()ing its body and keeping one branch. Cancelling the other
 * branch then waits for that kept branch forever, which is how intake hung to Vercel's 300s limit.
 * A signal opts the call out of the dedupe (next/dist/server/lib/dedupe-fetch.js).
 */
const RESEND_TIMEOUT_MS = 20_000;

/** Resend's verdict on one sender check. Anything but "pass" is treated as a failure. */
export type AuthResult = "pass" | "fail" | "gray" | "processing_failed" | "unknown";

export type InboundBody = {
  text: string;
  html: string;
  /**
   * SPF and DKIM as Resend's receiving MX judged them. The webhook does not carry these, only
   * the receiving API does. A field Resend omitted reads as "unknown", which fails closed.
   */
  spf: AuthResult;
  dkim: AuthResult;
  /** Text plus HTML plus the attachments' declared sizes, for the outside-sender size cap. */
  sizeBytes: number;
  /** Short-lived signed URL of the raw MIME message, for reading its header block. */
  rawUrl: string | null;
};

const AUTH_RESULTS: readonly AuthResult[] = ["pass", "fail", "gray", "processing_failed", "unknown"];

function authResult(value: unknown): AuthResult {
  return AUTH_RESULTS.includes(value as AuthResult) ? (value as AuthResult) : "unknown";
}

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
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
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

  let payload: {
    text?: unknown;
    html?: unknown;
    authentication?: { spf?: unknown; dkim?: unknown } | null;
    attachments?: unknown;
    raw?: { download_url?: unknown } | null;
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch (cause) {
    // A 2xx with a body that is not JSON should not surface as a bare SyntaxError. Same context as
    // the other failure paths so the worker's retry is legible.
    throw new Error(`resend receiving fetch for ${resendEmailId} returned unparseable JSON`, { cause });
  }
  const text = typeof payload.text === "string" ? payload.text : "";
  const html = typeof payload.html === "string" ? payload.html : "";
  const attachmentBytes = Array.isArray(payload.attachments)
    ? payload.attachments.reduce<number>((sum, attachment) => {
        const size = (attachment as { size?: unknown } | null)?.size;
        return sum + (typeof size === "number" && size > 0 ? size : 0);
      }, 0)
    : 0;
  return {
    text,
    html,
    spf: authResult(payload.authentication?.spf),
    dkim: authResult(payload.authentication?.dkim),
    sizeBytes: Buffer.byteLength(text) + Buffer.byteLength(html) + attachmentBytes,
    rawUrl: typeof payload.raw?.download_url === "string" ? payload.raw.download_url : null,
  };
}

/** The header block is small; a message whose headers run past this is not one we accept. */
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * Read only the header block of a received message from its signed raw URL.
 *
 * The body is never needed here, so the stream is cancelled at the first blank line, or at the
 * cap, whichever comes first. The URL is a pre-signed CDN link: no API key goes with it. A
 * non-2xx throws so intake answers 5xx and Resend redelivers.
 */
export async function fetchRawHeaders(rawUrl: string): Promise<string> {
  const response = await fetch(rawUrl, {
    headers: { "user-agent": "bountydesk-app" },
    signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`raw message fetch failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (/\r?\n\r?\n/.test(text) || text.length >= MAX_HEADER_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  // A chunk can carry the start of the body too; nothing past the blank line is returned.
  const end = text.search(/\r?\n\r?\n/);
  return (end >= 0 ? text.slice(0, end) : text).slice(0, MAX_HEADER_BYTES);
}

/**
 * The address BountyDesk sends from. mail.bountydesk.vaibhav.quest is the domain verified for
 * sending in Resend; a no-reply mailbox on it is enough for a transactional code, and nothing
 * reads replies to it.
 */
const VERIFICATION_FROM = "BountyDesk <no-reply@mail.bountydesk.vaibhav.quest>";

/**
 * Mail a reviewer their one-time verification code.
 *
 * This is a transactional send, not a verdict delivery: it carries no report content and creates no
 * DeliveryAttempt, so the verified-recipient and transport-receipt contract that gates verdict
 * delivery does not apply. A non-2xx throws so the action can tell the owner the code did not go
 * out, rather than leaving them waiting for a mail that never sent.
 */
export async function sendVerificationEmail(
  to: string,
  code: string,
  purpose: "reviewer" | "report-contact" = "reviewer",
): Promise<void> {
  const what =
    purpose === "reviewer"
      ? "Your BountyDesk reviewer verification code"
      : "The code that confirms this address for the report you uploaded to BountyDesk";
  const response = await fetch(`${RESEND_API}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requireSecret("RESEND_API_KEY")}`,
      "content-type": "application/json",
      "user-agent": "bountydesk-app",
    },
    body: JSON.stringify({
      from: VERIFICATION_FROM,
      to: [to],
      subject: `Your BountyDesk verification code: ${code}`,
      text: `${what} is ${code}.\n\nIt expires in 10 minutes. If you did not expect this, you can ignore this email.`,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`resend send to ${to} failed: ${response.status} ${detail.slice(0, 200)}`);
  }
}

/**
 * Verdicts are sent from the address the reporter already wrote to, not from no-reply, so that
 * hitting reply lands somewhere a human reads rather than a black hole.
 */
const VERDICT_FROM = "BountyDesk <reports@mail.bountydesk.vaibhav.quest>";

/**
 * Where the verdict email's images are served from.
 *
 * A constant rather than APP_BASE_URL on purpose, twice over. The body has to be a pure function
 * of the payload, because Resend refuses a retry that reuses an idempotency key with different
 * bytes, and an origin that varies between the app and the worker would do exactly that. And the
 * worker is a separate deployment with its own environment: APP_BASE_URL is not in it, and a var
 * the worker silently lacks is how the last live run burned five delivery attempts.
 */
export const EMAIL_ASSET_ORIGIN = "https://app.bountydesk.vaibhav.quest";

/**
 * How a failed send should be treated by the delivery worker.
 *
 * `transient` goes back on the retry backoff. `permanent` is refused for good. `mismatch` is the
 * one worth naming separately: it means this idempotency key was already used with a different
 * body, so either the payload changed after approval or two different verdicts collided on one
 * key. Retrying cannot fix it and issuing a fresh key would mail the reporter twice, so it stops
 * and asks for a human.
 */
export type SendDisposition = "transient" | "permanent" | "mismatch";

export class ResendSendError extends Error {
  readonly disposition: SendDisposition;
  readonly status: number | null;

  constructor(message: string, disposition: SendDisposition, status: number | null) {
    super(message);
    this.name = "ResendSendError";
    this.disposition = disposition;
    this.status = status;
  }
}

/** Resend's machine-readable name for the two different 409s. */
function dispositionFor(status: number, body: string): SendDisposition {
  if (status === 409) {
    // Another worker holds this key right now: safe to come back later, never a duplicate.
    return body.includes("concurrent_idempotent_requests") ? "transient" : "mismatch";
  }
  if (status === 408 || status === 429 || status >= 500) return "transient";
  return "permanent";
}

/**
 * Mail an approved verdict to a reporter.
 *
 * `idempotencyKey` is what makes a retry safe: email cannot be read back the way a GitHub issue
 * can, so Resend deduplicating on this key is the only thing standing between a crash mid-send and
 * a reporter receiving the same verdict twice. It holds the key for 24 hours and refuses a reuse
 * that carries a different body, which is why every field here must be a pure function of the
 * approved payload: a timestamp or an attempt counter in the body would turn a safe replay into a
 * mismatch.
 */
export async function sendVerdictEmail(opts: {
  to: string;
  subject: string;
  text: string;
  /** Omitted for a plain-text notice (the acknowledgement and the duplicate reply). */
  html?: string;
  idempotencyKey: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<{ id: string }> {
  let response: Response;
  try {
    response = await fetch(`${RESEND_API}/emails`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${requireSecret("RESEND_API_KEY")}`,
        "content-type": "application/json",
        "user-agent": "bountydesk-worker",
        "idempotency-key": opts.idempotencyKey,
      },
      body: JSON.stringify({
        from: VERDICT_FROM,
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
        ...(opts.html ? { html: opts.html } : {}),
        ...(opts.headers ? { headers: opts.headers } : {}),
      }),
      signal: opts.signal,
    });
  } catch {
    // DNS, reset connection, abort: nothing reached Resend, or we cannot tell. Retryable.
    throw new ResendSendError(`resend send to ${opts.to} failed to connect`, "transient", null);
  }

  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    throw new ResendSendError(
      `resend send to ${opts.to} failed: ${response.status} ${raw.slice(0, 300)}`,
      dispositionFor(response.status, raw),
      response.status,
    );
  }

  let id: unknown;
  try {
    id = (JSON.parse(raw) as { id?: unknown }).id;
  } catch {
    id = undefined;
  }
  if (typeof id !== "string" || id.length === 0) {
    // Accepted but unidentifiable: without an id nothing can correlate the delivery receipt, and
    // a retry would be a second mail. Refuse rather than guess.
    throw new ResendSendError(
      `resend accepted the send to ${opts.to} but returned no message id`,
      "permanent",
      response.status,
    );
  }
  return { id };
}
