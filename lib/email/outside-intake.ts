import { db, inboundJob, sql, type Executor } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";

import { checkFromAlignment } from "./alignment";
import type { InboundEmail } from "./inbound";
import { sendOversizedNotice } from "./notice";
import { fetchInboundBody, fetchRawHeaders, type InboundBody } from "./resend";

/**
 * Intake for mail from a sender who is not on the reviewer allowlist.
 *
 * Anyone can email the intake address, so an outside message has to earn a queue row. It is
 * accepted only when Resend's receiving MX saw both SPF and DKIM pass and its own
 * Authentication-Results aligns that pass with the From domain, when the sender and the
 * sender's domain are under their daily limits, and when the message is under the size cap.
 * Everything else is dropped with no job and no report. An accepted message still runs nothing
 * on its own: the worker holds it at the NEEDS_DECISION gate (lib/triage/gate.ts).
 */
export const OUTSIDE_LIMITS = {
  perSenderPerDay: 5,
  perDomainPerDay: 20,
  /** Text, HTML and declared attachment sizes together. */
  maxBytes: 512 * 1024,
} as const;

/** What an accepted outside message carries on its job. Server-written, never sender-written. */
export type OutsideEmailPayload = InboundEmail & {
  intake: "outside";
  /** The address that passed SPF and DKIM, recorded on the report as its verified sender. */
  verifiedSender: string;
};

export type OutsideAdmission = { accepted: true } | { accepted: false; reason: string };

export function senderDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Outside messages already queued in the last day from this sender and from its domain. The
 * jobs table is the record, so no second counter can drift from it. Only accepted mail has a
 * row, which matters: a forged message fails SPF/DKIM before it is counted, so nobody can spend
 * a real researcher's quota by spoofing their address.
 */
async function recentCounts(
  email: InboundEmail,
  tx: Executor,
): Promise<{ sender: number; domain: number }> {
  const domain = senderDomain(email.fromEmail);
  const rows = await tx.execute<{ sender: number; domain: number }>(sql`
    select count(*) filter (where ${inboundJob.payload}->>'fromEmail' = ${email.fromEmail})::int as sender,
           count(*)::int as domain
      from ${inboundJob}
     where ${inboundJob.channel} = 'email'
       and ${inboundJob.payload}->>'intake' = 'outside'
       and split_part(${inboundJob.payload}->>'fromEmail', '@', 2) = ${domain}
       and ${inboundJob.createdAt} > now() - interval '1 day'
       and ${inboundJob.deliveryId} <> ${email.messageId}
  `);
  return { sender: rows[0]?.sender ?? 0, domain: rows[0]?.domain ?? 0 };
}

function overLimit(counts: { sender: number; domain: number }): string | null {
  if (counts.sender >= OUTSIDE_LIMITS.perSenderPerDay) return "sender over its daily limit";
  if (counts.domain >= OUTSIDE_LIMITS.perDomainPerDay) return "domain over its daily limit";
  return null;
}

/**
 * Screen an outside message and enqueue it if it passes. A Resend fetch failure throws, so the
 * route can answer 5xx and let Resend redeliver rather than drop a message it never checked.
 */
export async function admitOutsideEmail(
  email: InboundEmail,
  deps: {
    fetchBody?: (resendEmailId: string) => Promise<InboundBody>;
    fetchHeaders?: (rawUrl: string) => Promise<string>;
    /** Courtesy reply on the size-cap drop. Injected in tests; the default hits Resend. */
    notifyOversized?: (email: InboundEmail) => Promise<void>;
  } = {},
): Promise<OutsideAdmission> {
  const fetchBody = deps.fetchBody ?? fetchInboundBody;
  const fetchHeaders = deps.fetchHeaders ?? fetchRawHeaders;
  const notifyOversized =
    deps.notifyOversized ?? (async (e) => void (await sendOversizedNotice(e)));

  // SPF and DKIM come only from the receiving API, which is keyed by Resend's id.
  if (!email.resendEmailId) return { accepted: false, reason: "no Resend id to verify the sender with" };

  // Checked before the fetch so a flood from one domain costs a count, not an API call each.
  const early = overLimit(await recentCounts(email, db));
  if (early) return { accepted: false, reason: early };

  const message = await fetchBody(email.resendEmailId);
  if (message.spf !== "pass" || message.dkim !== "pass") {
    return { accepted: false, reason: `sender not authenticated (spf ${message.spf}, dkim ${message.dkim})` };
  }
  // A pass on its own does not say which domain passed. The address we store and reply to must be
  // the one the receiving MX authenticated (lib/email/alignment.ts).
  if (!message.rawUrl) return { accepted: false, reason: "no raw message to check alignment with" };
  const alignment = checkFromAlignment(await fetchHeaders(message.rawUrl), senderDomain(email.fromEmail));
  if (!alignment.ok) return { accepted: false, reason: `From not aligned: ${alignment.reason}` };

  // The size check runs only after SPF, DKIM and alignment all pass, so the drop notice below goes
  // only to an address the receiving MX authenticated. A forged oversized message is dropped at
  // one of the checks above and never earns a reply, so it cannot be used to mail a third party.
  // The rate-limit drops above stay silent on purpose: a notice there would let a flood amplify
  // into outbound mail.
  if (message.sizeBytes > OUTSIDE_LIMITS.maxBytes) {
    await notifyOversized(email);
    return { accepted: false, reason: `message is ${message.sizeBytes} bytes, over the cap` };
  }

  const payload: OutsideEmailPayload = { ...email, intake: "outside", verifiedSender: email.fromEmail };

  // The recount and the insert share a transaction holding a per-domain advisory lock, so two
  // messages arriving together cannot both read "one under the limit" and both get in. The lock
  // is taken after the Resend fetch, never across it.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`outside-email:${senderDomain(email.fromEmail)}`}))`);
    const late = overLimit(await recentCounts(email, tx));
    if (late) return { accepted: false, reason: late };
    await enqueue({ channel: "email", deliveryId: email.messageId, payload }, tx);
    return { accepted: true };
  });
}
