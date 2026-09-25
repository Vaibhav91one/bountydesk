import { db, inboundJob, sql, type Executor } from "@/lib/db";
import { enqueue } from "@/lib/jobs/queue";

import { checkFromAlignment } from "./alignment";
import type { InboundEmail } from "./inbound";
import { sendOversizedNotice } from "./notice";
import { readOutsideConfig, type OutsideConfig } from "./outside-config";
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
/**
 * The defaults readOutsideConfig falls back to when the config table has no row. Kept exported so
 * other code and tests can read today's numbers without a database round-trip.
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
 * Outside messages that already spent a slot in the last day from this sender and from its domain:
 * accepted reports and oversized drops both write an outside inbound_job row, and both send one
 * mail, so counting the rows bounds the outbound mail. The jobs table is the record, so no second
 * counter can drift from it. Only a message that passed SPF/DKIM (and, at the drop, alignment) ever
 * gets a row, which matters: a forged message is rejected before it is counted, so nobody can spend
 * a real researcher's quota, or trigger mail to them, by spoofing their address.
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

/**
 * The per-sender cap and, unless the domain is exempt, the per-domain cap. An exempt domain is a
 * free-mail provider whose senders are unrelated, so charging them a shared bucket would let one
 * user starve the rest; they still get the per-sender cap, which is the one that bounds a single
 * researcher. fromEmail is needed to decide exemption, so it is threaded in alongside the counts.
 */
export function overLimit(
  counts: { sender: number; domain: number },
  fromEmail: string,
  config: OutsideConfig,
): string | null {
  if (counts.sender >= config.perSenderPerDay) return "sender over its daily limit";
  if (!config.exemptDomains.includes(senderDomain(fromEmail)) && counts.domain >= config.perDomainPerDay) {
    return "domain over its daily limit";
  }
  return null;
}

/**
 * Refuse an oversized message and tell its verified sender once, without letting that reply become
 * an amplifier.
 *
 * The notice counts against the same daily budget as an accepted message: a domain owner needs only
 * domain control to pass SPF, DKIM and alignment, so without a cap an endless stream of >512KB mail
 * would become an endless stream of outbound Resend sends. The budget is spent by a terminal
 * inbound_job row (state DONE, which claim() never picks up) that recentCounts reads exactly like an
 * accepted message's row, so the accepted path and this one draw from one 5-per-sender, 20-per-domain
 * pool. Over the budget, the message is dropped in silence, the same as a rate-limit drop.
 *
 * The row is written under the per-domain advisory lock and committed before the send, so the lock
 * is never held across the network call and two messages arriving together cannot both slip under
 * the cap. The send failure is swallowed on purpose: this drop is terminal, and a throw here would
 * become a 5xx that makes Resend redeliver the inbound webhook and retry the send on every
 * redelivery. The idempotency key inside sendOversizedNotice, keyed on the message id, is what stops
 * a redelivery that does get through from mailing the sender twice.
 */
async function dropOversized(
  email: InboundEmail,
  sizeBytes: number,
  notifyOversized: (email: InboundEmail) => Promise<void>,
  config: OutsideConfig,
): Promise<OutsideAdmission> {
  const reason = `message is ${sizeBytes} bytes, over the cap`;

  const spend = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`outside-email:${senderDomain(email.fromEmail)}`}))`);
    if (overLimit(await recentCounts(email, tx), email.fromEmail, config)) return false;
    // Counted, never processed: state DONE keeps it off claim(), and the payload is only what
    // recentCounts reads (the sender and the outside marker) plus a drop tag for the audit trail.
    // A redelivery collides on (channel, delivery_id) and adds nothing, so the budget is spent once.
    await tx
      .insert(inboundJob)
      .values({
        channel: "email",
        deliveryId: email.messageId,
        state: "DONE",
        payload: { intake: "outside", fromEmail: email.fromEmail, drop: "oversized" } as never,
      })
      .onConflictDoNothing({ target: [inboundJob.channel, inboundJob.deliveryId] });
    return true;
  });

  if (spend) {
    try {
      await notifyOversized(email);
    } catch (error) {
      console.error(`oversized-drop notice for ${email.messageId} failed to send`, error);
    }
  }
  return { accepted: false, reason };
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

  // Read the tunable limits once, so every gate below (early check, size cap, the locked recount)
  // sees the same numbers even if an owner edits them mid-flight.
  const config = await readOutsideConfig();

  // Checked before the fetch so a flood from one domain costs a count, not an API call each.
  const early = overLimit(await recentCounts(email, db), email.fromEmail, config);
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

  // The size check runs only after SPF, DKIM and alignment all pass, so the drop notice goes only
  // to an address the receiving MX authenticated. A forged oversized message is dropped at one of
  // the checks above and never earns a reply, so it cannot be used to mail a third party.
  if (message.sizeBytes > config.maxBytes) {
    return dropOversized(email, message.sizeBytes, notifyOversized, config);
  }

  const payload: OutsideEmailPayload = { ...email, intake: "outside", verifiedSender: email.fromEmail };

  // The recount and the insert share a transaction holding a per-domain advisory lock, so two
  // messages arriving together cannot both read "one under the limit" and both get in. The lock
  // is taken after the Resend fetch, never across it.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`outside-email:${senderDomain(email.fromEmail)}`}))`);
    const late = overLimit(await recentCounts(email, tx), email.fromEmail, config);
    if (late) return { accepted: false, reason: late };
    await enqueue({ channel: "email", deliveryId: email.messageId, payload }, tx);
    return { accepted: true };
  });
}
