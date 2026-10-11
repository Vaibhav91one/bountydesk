import {
  and,
  db,
  desc,
  devicePushToken,
  eq,
  gt,
  isNull,
  notificationEvent,
  outboundDelivery,
  report,
  sql,
  verdict,
} from "@/lib/db";
import { isReviewerEmail } from "@/lib/auth/reviewers";
import { sourceLabel } from "@/lib/reports/queue";

/** A single push message handed to the Expo push service. */
export type PushMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
};

/** The result of a sweep: candidates seen, messages sent, tokens revoked. */
export type SweepResult = {
  candidates: number;
  sent: number;
  revoked: number;
};

/** A ticket returned by the Expo push service, one per message sent. */
export type ExpoTicket = {
  id: string;
  details?: { error?: string };
};

/**
 * Sends push messages to the Expo push service. Returns one ticket per message, in the same
 * order the messages were sent, so the caller can correlate a ticket back to its token.
 */
export type SendFn = (messages: PushMessage[]) => Promise<ExpoTicket[]>;

/** The candidate query is capped to reports updated in the last 24 hours. */
const RECENT_MS = 24 * 60 * 60 * 1000;

type Candidate = {
  reportId: string;
  sourceRef: string;
  sourceLabel: string;
  kind: "AWAITING_APPROVAL" | "DELIVERED";
  refId: string;
};

/**
 * Leaves out a (report, kind, ref) that already has a notification_event, so a sweep that runs
 * every minute reads the 24-hour window without attempting an insert for every row in it.
 */
function notNotified(kind: "AWAITING_APPROVAL" | "DELIVERED", refId: ReturnType<typeof sql>) {
  return sql`not exists (
    select 1 from ${notificationEvent}
    where ${notificationEvent.reportId} = ${report.id}
      and ${notificationEvent.kind} = ${kind}
      and ${notificationEvent.refId} = ${refId}
  )`;
}

/**
 * Find reports that reached AWAITING_APPROVAL or DELIVERED in the last 24 hours, with the
 * verdict id (for AWAITING_APPROVAL) or outbound delivery id (for DELIVERED) as ref_id.
 * sourceLabel comes from lib/reports/queue.ts so the push names a report the way the lists do.
 */
async function selectCandidates(now: Date): Promise<Candidate[]> {
  const since = new Date(now.getTime() - RECENT_MS);

  const awaiting = await db
    .select({ reportId: report.id, sourceRef: report.sourceRef, refId: verdict.id })
    .from(report)
    .innerJoin(verdict, eq(verdict.reportId, report.id))
    .where(
      and(
        eq(report.state, "AWAITING_APPROVAL"),
        gt(report.updatedAt, since),
        notNotified("AWAITING_APPROVAL", sql`${verdict.id}::text`),
      ),
    )
    // revision is the verdict's order; the newest one is what the reviewer is asked to sign.
    .orderBy(report.id, desc(verdict.revision));

  const delivered = await db
    .select({ reportId: report.id, sourceRef: report.sourceRef, refId: outboundDelivery.id })
    .from(report)
    .innerJoin(outboundDelivery, eq(outboundDelivery.reportId, report.id))
    .where(
      and(
        eq(report.state, "DELIVERED"),
        gt(report.updatedAt, since),
        eq(outboundDelivery.state, "SENT"),
        notNotified("DELIVERED", sql`${outboundDelivery.id}::text`),
      ),
    )
    .orderBy(report.id, desc(outboundDelivery.createdAt));

  // Deduplicate to the latest verdict (for AWAITING_APPROVAL) or delivery (for DELIVERED).
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const row of awaiting) {
    if (seen.has(row.reportId)) continue;
    seen.add(row.reportId);
    candidates.push({ ...row, refId: String(row.refId), sourceLabel: sourceLabel(row.sourceRef, row.reportId), kind: "AWAITING_APPROVAL" });
  }

  for (const row of delivered) {
    if (seen.has(row.reportId)) continue;
    seen.add(row.reportId);
    candidates.push({ ...row, refId: String(row.refId), sourceLabel: sourceLabel(row.sourceRef, row.reportId), kind: "DELIVERED" });
  }

  return candidates;
}

/** Loads non-revoked tokens whose email is currently on the reviewer allowlist. */
async function loadEligibleTokens() {
  const rows = await db
    .select({
      token: devicePushToken.token,
      reviewerEmail: devicePushToken.reviewerEmail,
    })
    .from(devicePushToken)
    .where(isNull(devicePushToken.revokedAt));

  const eligible: Array<{ token: string; reviewerEmail: string }> = [];
  for (const row of rows) {
    if (await isReviewerEmail(row.reviewerEmail)) eligible.push(row);
  }
  return eligible;
}

/** Default send implementation: POST to exp.host/v2/push/send in batches of 100. */
export const sendExpoPush: SendFn = async (messages: PushMessage[]) => {
  const tickets: ExpoTicket[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.EXPO_ACCESS_TOKEN
          ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`Expo push send failed: ${res.status} ${res.statusText}`);
    }
    const result = (await res.json()) as ExpoTicket[];
    tickets.push(...result);
  }
  return tickets;
};

/** Build the push message for a candidate, per the payload rules. */
function buildMessage(token: string, candidate: Candidate): PushMessage {
  if (candidate.kind === "AWAITING_APPROVAL") {
    return {
      to: token,
      title: "Verdict awaiting approval",
      body: candidate.sourceLabel,
      data: { reportId: candidate.reportId, screen: "sign" },
    };
  }
  return {
    to: token,
    title: "Verdict delivered",
    body: candidate.sourceLabel,
    data: { reportId: candidate.reportId, screen: "case" },
  };
}

/** Revoke a token that Expo says is no longer registered. */
async function revokeToken(token: string) {
  await db
    .update(devicePushToken)
    .set({ revokedAt: new Date() })
    .where(eq(devicePushToken.token, token));
}

/**
 * Sweep reports that reached AWAITING_APPROVAL or DELIVERED in the last 24 hours and notify
 * each eligible, non-revoked token once per (report, kind, ref_id).
 */
export async function sweepPushNotifications(opts?: {
  send?: SendFn;
  now?: Date;
}): Promise<SweepResult> {
  const now = opts?.now ?? new Date();
  const send = opts?.send ?? sendExpoPush;

  const candidates = await selectCandidates(now);
  if (candidates.length === 0) return { candidates: 0, sent: 0, revoked: 0 };

  const tokens = await loadEligibleTokens();
  if (tokens.length === 0) return { candidates: candidates.length, sent: 0, revoked: 0 };

  let sent = 0;
  let revoked = 0;

  for (const candidate of candidates) {
    // ponytail: a crash between this insert and the send below drops that one push. The
    // notification_event row exists, so the sweep will not retry — but the device gets nothing.
    // An outbox status column (sent vs. delivered-at) is the upgrade that would let a retry
    // recover the gap.
    const [inserted] = await db
      .insert(notificationEvent)
      .values({
        reportId: candidate.reportId,
        kind: candidate.kind,
        refId: candidate.refId,
      })
      .onConflictDoNothing()
      .returning({ id: notificationEvent.id });

    if (!inserted) continue; // already notified

    const messages: PushMessage[] = [];
    for (const { token } of tokens) {
      messages.push(buildMessage(token, candidate));
    }

    try {
      const tickets = await send(messages);
      sent += tickets.length;

      // Expo returns one ticket per message, in order. Zip to find which token errored.
      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.details?.error === "DeviceNotRegistered") {
          await revokeToken(messages[i].to);
          revoked++;
        }
      }
    } catch (err) {
      // A batch failure does not abort the whole sweep; the next candidate still gets notified.
      console.warn(
        `push notification send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { candidates: candidates.length, sent, revoked };
}
