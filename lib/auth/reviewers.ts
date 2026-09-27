import { and, db, eq, isNotNull, reviewer } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import {
  CODE_TTL_MS,
  codeMatches,
  EMAIL_SHAPE,
  generateCode,
  hashCode,
  MAX_CODE_ATTEMPTS,
} from "./otp";

/**
 * Who may operate BountyDesk.
 *
 * Sign-in (Clerk, via Google or GitHub) answers "which account is this", which is not the same
 * question as "may this person approve a verdict". Without a second answer, every account on the
 * internet is an operator. The allowlist is that second answer, checked on every protected
 * request rather than only at login, so removing someone takes effect at once.
 *
 * The allowlist has two layers. The REVIEWER_EMAILS env holds the owners: the bootstrap admins,
 * always authorized and the only ones who may change the list. The `reviewer` table holds members
 * an owner added from the dashboard, authorized to operate but not to manage. Owners in the env and
 * members in the database means the database can be wiped without locking everyone out, and no
 * dashboard action can remove the people who bootstrap access.
 *
 * A third allowlist, deliberately independent: the GitHub-issue `/reproduce` gate authorizes by
 * GitHub numeric id, because it matches a webhook actor and never involves a dashboard login.
 */
export function reviewerEmails(): Set<string> {
  const raw = requireEnv("REVIEWER_EMAILS");
  const emails = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

  if (emails.length === 0) {
    throw new Error("REVIEWER_EMAILS is empty, so nobody could review anything");
  }
  return new Set(emails);
}

function normalize(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length ? trimmed : null;
}

/** Is this an owner: on the env allowlist? Owners bootstrap access and manage the list. */
export function isOwnerEmail(email: string | null | undefined): boolean {
  const normalized = normalize(email);
  return normalized ? reviewerEmails().has(normalized) : false;
}

/** Only owners may add or remove members. */
export const canManageReviewers = isOwnerEmail;

/**
 * Dashboard and intake authorization: is this an owner or a verified member? Async because a member
 * lives in the database. Owners short-circuit, so the env allowlist still answers without a query
 * and a database outage never locks an owner out. A member counts only once verified_at is set: a
 * pending row, added but not yet confirmed by its one-time code, authorizes nothing.
 */
export async function isReviewerEmail(email: string | null | undefined): Promise<boolean> {
  const normalized = normalize(email);
  if (!normalized) return false;
  if (reviewerEmails().has(normalized)) return true;

  const [row] = await db
    .select({ email: reviewer.email })
    .from(reviewer)
    .where(and(eq(reviewer.email, normalized), isNotNull(reviewer.verifiedAt)))
    .limit(1);
  return Boolean(row);
}

export type ReviewerEntry = {
  email: string;
  role: "owner" | "member";
  /** True for an owner; for a member, true once the one-time code has been entered. */
  verified: boolean;
  /** A pending member with a code that has been mailed and not yet expired, awaiting entry. */
  codeOutstanding: boolean;
  addedByEmail: string | null;
  createdAt: Date | null;
};

/** The full allowlist for the management screen: env owners first, then added members. */
export async function listReviewers(): Promise<ReviewerEntry[]> {
  const owners = reviewerEmails();
  const ownerEntries: ReviewerEntry[] = [...owners].map((email) => ({
    email,
    role: "owner",
    verified: true,
    codeOutstanding: false,
    addedByEmail: null,
    createdAt: null,
  }));

  const now = Date.now();
  const rows = await db.select().from(reviewer).orderBy(reviewer.email);
  const memberEntries: ReviewerEntry[] = rows
    // An address that is both env owner and a stale db row shows once, as an owner.
    .filter((row) => !owners.has(row.email))
    .map((row) => ({
      email: row.email,
      role: "member",
      verified: row.verifiedAt !== null,
      codeOutstanding:
        row.verifiedAt === null &&
        row.codeHash !== null &&
        row.codeExpiresAt !== null &&
        row.codeExpiresAt.getTime() > now,
      addedByEmail: row.addedByEmail,
      createdAt: row.createdAt,
    }));

  return [...ownerEntries, ...memberEntries];
}

export type StartVerificationResult =
  | { status: "code_sent"; code: string }
  | { status: "already_verified" };

/**
 * Begin verifying a member. Creates or refreshes the pending row and returns a fresh one-time code
 * for the caller to mail; the row stores only the hash. An address that is already an env owner is
 * rejected (owners are set in the env), and one that is already a verified member is a no-op.
 *
 * The code is returned rather than sent here so this stays a pure database function: the Resend
 * send, its failure modes and its rate limit belong to the action that calls this.
 */
export async function startVerification(
  email: string,
  addedByEmail: string,
): Promise<StartVerificationResult> {
  const normalized = normalize(email);
  if (!normalized || !EMAIL_SHAPE.test(normalized)) {
    throw new Error(`"${email}" is not a valid email address`);
  }
  // An owner is already authorized through the env, so connecting their address is not an error,
  // it is a no-op: there is nothing to verify. An owner adding their own email lands here.
  if (reviewerEmails().has(normalized)) {
    return { status: "already_verified" };
  }

  const [existing] = await db
    .select({ verifiedAt: reviewer.verifiedAt })
    .from(reviewer)
    .where(eq(reviewer.email, normalized))
    .limit(1);
  if (existing?.verifiedAt) return { status: "already_verified" };

  const code = generateCode();
  const values = {
    email: normalized,
    addedByEmail: normalize(addedByEmail),
    codeHash: hashCode(code),
    codeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
    codeAttempts: 0,
    verifiedAt: null,
  };
  await db
    .insert(reviewer)
    .values(values)
    .onConflictDoUpdate({
      target: reviewer.email,
      set: {
        codeHash: values.codeHash,
        codeExpiresAt: values.codeExpiresAt,
        codeAttempts: 0,
      },
    });

  return { status: "code_sent", code };
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

/**
 * Confirm a member with the code that was mailed to them. A correct code within its window sets
 * verified_at and clears the code. A wrong code spends one of a small number of attempts; an
 * expired code or an exhausted attempt count is refused and asks for a new code. The stored hash is
 * compared in constant time, which is cheap insurance even though the attempt cap already bounds
 * guessing.
 */
export async function verifyCode(email: string, code: string): Promise<VerifyResult> {
  const normalized = normalize(email);
  if (!normalized) return { ok: false, error: "No address given." };
  const submitted = code.trim();
  if (!/^\d{6}$/.test(submitted)) return { ok: false, error: "Enter the six-digit code." };

  const [row] = await db
    .select()
    .from(reviewer)
    .where(eq(reviewer.email, normalized))
    .limit(1);
  if (!row || !row.codeHash || !row.codeExpiresAt) {
    return { ok: false, error: "There is no pending code for that address. Send a new one." };
  }
  if (row.verifiedAt) return { ok: true };
  if (row.codeExpiresAt.getTime() < Date.now()) {
    return { ok: false, error: "That code has expired. Send a new one." };
  }
  if (row.codeAttempts >= MAX_CODE_ATTEMPTS) {
    return { ok: false, error: "Too many attempts. Send a new code." };
  }

  if (!codeMatches(row.codeHash, submitted)) {
    await db
      .update(reviewer)
      .set({ codeAttempts: row.codeAttempts + 1 })
      .where(eq(reviewer.email, normalized));
    return { ok: false, error: "That code is not correct." };
  }

  await db
    .update(reviewer)
    .set({ verifiedAt: new Date(), codeHash: null, codeExpiresAt: null, codeAttempts: 0 })
    .where(eq(reviewer.email, normalized));
  return { ok: true };
}

/** Remove a member (pending or verified). An env owner cannot be removed here. */
export async function removeReviewer(email: string): Promise<void> {
  const normalized = normalize(email);
  if (!normalized) return;
  if (reviewerEmails().has(normalized)) {
    throw new Error("an owner is set in REVIEWER_EMAILS and cannot be removed from the dashboard");
  }
  await db.delete(reviewer).where(eq(reviewer.email, normalized));
}

/**
 * The GitHub numeric ids allowed to trigger `/reproduce` from an issue. Unchanged from the
 * GitHub-native actor model: a login can be changed or reassigned, the id cannot.
 */
export function reviewerIds(): Set<number> {
  const raw = requireEnv("REVIEWER_GITHUB_IDS");

  const ids = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      if (!/^\d+$/.test(part)) {
        throw new Error(
          `REVIEWER_GITHUB_IDS must be a comma-separated list of numeric GitHub user ids; got "${part}"`,
        );
      }
      return Number(part);
    });

  if (ids.length === 0) {
    throw new Error("REVIEWER_GITHUB_IDS is empty, so nobody could review anything");
  }

  return new Set(ids);
}

/** GitHub-webhook authorization: is this webhook sender a reviewer? */
export function isReviewer(userId: number): boolean {
  return reviewerIds().has(userId);
}
