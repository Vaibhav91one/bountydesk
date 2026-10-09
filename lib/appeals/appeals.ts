import { isReviewerWriter } from "@/lib/auth/reviewers";
import {
  CODE_TTL_MS,
  codeMatches,
  EMAIL_SHAPE,
  generateCode,
  hashCode,
  MAX_CODE_ATTEMPTS,
  normalizeEmail,
} from "@/lib/auth/otp";
import {
  and,
  appeal,
  appealCode,
  db,
  desc,
  eq,
  isNotNull,
  outboundDelivery,
  report,
  sql,
  verdict,
  type Executor,
} from "@/lib/db";
import { isVerifiedEmailRecipient } from "@/lib/email/recipient";
import { sendVerificationEmail } from "@/lib/email/resend";
import { safeErrorText } from "@/lib/errors/safe-error";

/**
 * A reporter contesting a delivered verdict. See docs/decisions.md Q35.
 *
 * The endpoint is public, so identity comes from a one-time code mailed to the address the report's
 * delivery already went to. That code lives in appeal_code, not on the report row: the upload
 * helper startContactVerification rewrites report.reporter_contact and clears verified_sender,
 * which is right for an unproven upload and would let anyone who knows a report id break a
 * delivered report's recipient proof here. The code primitives (lib/auth/otp.ts) are shared.
 */

export const APPEAL_LIMITS = {
  maxRequestBytes: 16 * 1024,
  maxBodyChars: 4000,
  /** Code requests from one client address per day, eligible or not. */
  perAddressPerDay: 10,
  /** Codes one report's contact may be mailed per day. */
  maxCodesPerReportPerDay: 3,
} as const;

/** Relative on purpose: the reviewer reads it on the app's own origin. */
export function appealPath(reportId: string): string {
  return `/appeal?report=${reportId}`;
}

export type SendCode = (to: string, code: string) => Promise<void>;
const defaultSendCode: SendCode = (to, code) => sendVerificationEmail(to, code, "appeal");

/**
 * The verdict an appeal would contest: the latest revision whose delivery actually completed
 * (delivered_at set by the transport receipt), never one that was only approved or queued.
 */
async function deliveredVerdictId(reportId: string, tx: Executor): Promise<string | null> {
  const [row] = await tx
    .select({ id: verdict.id })
    .from(verdict)
    .innerJoin(outboundDelivery, eq(outboundDelivery.verdictId, verdict.id))
    .where(and(eq(verdict.reportId, reportId), isNotNull(outboundDelivery.deliveredAt)))
    .orderBy(desc(verdict.revision))
    .limit(1);
  return row?.id ?? null;
}

/** The report's delivery contact, only when `contact` is exactly that proven address. */
async function isDeliveryContact(reportId: string, contact: string, tx: Executor): Promise<boolean> {
  const [row] = await tx
    .select({ reporterContact: report.reporterContact, verifiedSender: report.verifiedSender })
    .from(report)
    .where(eq(report.id, reportId))
    .limit(1);
  if (!row || normalizeEmail(row.reporterContact) !== contact) return false;
  return isVerifiedEmailRecipient(row);
}

export type CodeRequest = { ok: true } | { ok: false; status: 429; error: string };

/**
 * Mail a code to `contact` if it is the delivery contact of a report with a delivered verdict.
 * Every other case, a missing report included, returns the same ok and mails nothing, so the
 * response cannot be used to learn whether a report exists.
 *
 * ponytail: one global advisory lock for the count-then-insert, like upload intake.
 */
export async function requestAppealCode(
  reportId: string,
  rawContact: string,
  clientIp: string | null,
  sendCode: SendCode = defaultSendCode,
  // A route hands in next/server `after` so the Resend call is off the response path; otherwise the
  // matching case would take visibly longer than the others.
  defer: (task: () => Promise<void>) => void | Promise<void> = (task) => task(),
): Promise<CodeRequest> {
  const contact = normalizeEmail(rawContact) ?? "";
  const wellFormed = EMAIL_SHAPE.test(contact) && contact.length <= 254;

  const code = generateCode();
  const outcome = await db.transaction(async (tx): Promise<"limited" | "mail" | "silent"> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('appeal-code'))`);
    if (clientIp) {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(appealCode)
        .where(and(eq(appealCode.clientIp, clientIp), sql`${appealCode.createdAt} > now() - interval '1 day'`));
      if ((row?.n ?? 0) >= APPEAL_LIMITS.perAddressPerDay) return "limited";
    }

    const eligible =
      wellFormed &&
      (await isDeliveryContact(reportId, contact, tx)) &&
      (await deliveredVerdictId(reportId, tx)) !== null;
    let mail = eligible;
    if (eligible) {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(appealCode)
        .where(
          and(
            eq(appealCode.reportId, reportId),
            isNotNull(appealCode.expiresAt),
            sql`${appealCode.createdAt} > now() - interval '1 day'`,
          ),
        );
      mail = (row?.n ?? 0) < APPEAL_LIMITS.maxCodesPerReportPerDay;
    }

    await tx.insert(appealCode).values({
      reportId,
      contact: wellFormed ? contact : "",
      codeHash: mail ? hashCode(code) : null,
      expiresAt: mail ? new Date(Date.now() + CODE_TTL_MS) : null,
      clientIp,
    });
    return mail ? "mail" : "silent";
  });

  if (outcome === "limited") return { ok: false, status: 429, error: "Too many requests from this address. Try again tomorrow." };
  if (outcome === "mail") {
    await defer(async () => {
      try {
        await sendCode(contact, code);
      } catch (error) {
        console.error(`appeal: code for ${reportId} did not send: ${safeErrorText(error)}`);
      }
    });
  }
  return { ok: true };
}

export type SubmitAppeal =
  | { ok: true; appealId: string }
  | { ok: false; status: 400 | 409; error: string };

const CODE_REFUSED: SubmitAppeal = {
  ok: false,
  status: 400,
  error: "That code is not valid. Request a new one.",
};

/**
 * File the appeal. Input-shape checks (code format, empty or over-long body) answer first and say
 * what is wrong. After those, every failure to prove the contact (unknown report, other address, no
 * code, expired, wrong, attempts spent) gets the same answer. Only after the code checks out does the
 * caller learn why an otherwise valid appeal is refused, since by then they have proven they own
 * the report's contact.
 */
export async function submitAppeal(input: {
  reportId: string;
  contact: string;
  code: string;
  body: string;
}): Promise<SubmitAppeal> {
  const contact = normalizeEmail(input.contact) ?? "";
  const code = input.code.trim();
  const body = input.body.trim();
  if (!/^\d{6}$/.test(code) || !contact) return CODE_REFUSED;
  if (!body) return { ok: false, status: 400, error: "Write what you are appealing." };
  if (body.length > APPEAL_LIMITS.maxBodyChars) {
    return { ok: false, status: 400, error: `The appeal is over ${APPEAL_LIMITS.maxBodyChars} characters.` };
  }

  // Returning normally commits, which is what persists a failed-attempt increment. Only the
  // duplicate path throws, to roll back the code consumption along with the refused insert.
  class Duplicate extends Error {}
  try {
    return await db.transaction(async (tx): Promise<SubmitAppeal> => {
      const [row] = await tx
        .select()
        .from(appealCode)
        .where(and(eq(appealCode.reportId, input.reportId), eq(appealCode.contact, contact), isNotNull(appealCode.codeHash)))
        .orderBy(desc(appealCode.createdAt))
        .limit(1)
        .for("update");

      if (!row?.codeHash || !row.expiresAt || row.expiresAt.getTime() < Date.now()) return CODE_REFUSED;
      if (row.attempts >= MAX_CODE_ATTEMPTS) return CODE_REFUSED;
      if (!codeMatches(row.codeHash, code)) {
        await tx.update(appealCode).set({ attempts: row.attempts + 1 }).where(eq(appealCode.id, row.id));
        return CODE_REFUSED;
      }
      // Single use: spent before anything else can fail. expires_at stays set so the daily mail cap still counts this code.
      await tx.update(appealCode).set({ codeHash: null }).where(eq(appealCode.id, row.id));

      // Re-checked at filing: the code was issued for a delivered verdict and this binds the
      // appeal to the one that is delivered now.
      const verdictId = await deliveredVerdictId(input.reportId, tx);
      if (!verdictId || !(await isDeliveryContact(input.reportId, contact, tx))) {
        return { ok: false, status: 409, error: "There is no delivered verdict on this report to appeal." };
      }

      try {
        const [created] = await tx
          .insert(appeal)
          .values({ reportId: input.reportId, verdictId, body, contact })
          .returning({ id: appeal.id });
        return { ok: true, appealId: created.id };
      } catch (error) {
        // drizzle wraps the driver error, so the SQLSTATE sits on cause.
        const sqlState = (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
        if (sqlState === "23505") throw new Duplicate();
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof Duplicate) {
      return { ok: false, status: 409, error: "An appeal on this verdict is already open." };
    }
    throw error;
  }
}

export type CaseAppeal = typeof appeal.$inferSelect;

/** Appeals on a report, newest first. Reviewer-side read; the body is untrusted reporter text. */
export async function listAppeals(reportId: string): Promise<CaseAppeal[]> {
  return db.select().from(appeal).where(eq(appeal.reportId, reportId)).orderBy(desc(appeal.createdAt));
}

export type ResolveResult = { ok: true } | { ok: false; error: string };

/**
 * Move an appeal forward. Re-checks the writer role itself, so a read-only reviewer is refused
 * whichever surface calls this. Nothing is sent to the reporter from here. The report is DELIVERED,
 * a terminal state with no edge back, so requestRecheck cannot run on it; the reviewer replies
 * outside the app and records the outcome in the close note.
 */
export async function resolveAppeal(
  reportId: string,
  appealId: string,
  action: "acknowledge" | "close",
  reviewer: { email: string; login: string },
  note?: string,
): Promise<ResolveResult> {
  if (!(await isReviewerWriter(reviewer.email))) return { ok: false, error: "This reviewer has read-only access." };

  const trimmed = note?.trim() || null;
  if (trimmed && trimmed.length > APPEAL_LIMITS.maxBodyChars) return { ok: false, error: "The note is too long." };

  const set =
    action === "acknowledge"
      ? { status: "ACKNOWLEDGED" }
      : { status: "CLOSED", resolutionNote: trimmed, resolvedBy: reviewer.login, resolvedAt: new Date() };
  // Forward only: OPEN -> ACKNOWLEDGED, and either -> CLOSED. A closed appeal stays closed.
  const from = action === "acknowledge" ? sql`${appeal.status} = 'OPEN'` : sql`${appeal.status} <> 'CLOSED'`;
  const updated = await db
    .update(appeal)
    .set(set)
    .where(and(eq(appeal.id, appealId), eq(appeal.reportId, reportId), from))
    .returning({ id: appeal.id });
  return updated.length ? { ok: true } : { ok: false, error: "That appeal cannot move that way." };
}
