import { db, eq, reviewer } from "@/lib/db";
import { requireEnv } from "@/lib/env";

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
 * Dashboard and intake authorization: is this an owner or an added member? Async because a member
 * lives in the database. Owners short-circuit, so the env allowlist still answers without a query
 * and a database outage never locks an owner out.
 */
export async function isReviewerEmail(email: string | null | undefined): Promise<boolean> {
  const normalized = normalize(email);
  if (!normalized) return false;
  if (reviewerEmails().has(normalized)) return true;

  const [row] = await db
    .select({ email: reviewer.email })
    .from(reviewer)
    .where(eq(reviewer.email, normalized))
    .limit(1);
  return Boolean(row);
}

export type ReviewerEntry = {
  email: string;
  role: "owner" | "member";
  addedByEmail: string | null;
  createdAt: Date | null;
};

/** The full allowlist for the settings screen: env owners first, then added members. */
export async function listReviewers(): Promise<ReviewerEntry[]> {
  const owners = reviewerEmails();
  const ownerEntries: ReviewerEntry[] = [...owners].map((email) => ({
    email,
    role: "owner",
    addedByEmail: null,
    createdAt: null,
  }));

  const rows = await db.select().from(reviewer).orderBy(reviewer.email);
  const memberEntries: ReviewerEntry[] = rows
    // An address that is both env owner and a stale db row shows once, as an owner.
    .filter((row) => !owners.has(row.email))
    .map((row) => ({
      email: row.email,
      role: "member",
      addedByEmail: row.addedByEmail,
      createdAt: row.createdAt,
    }));

  return [...ownerEntries, ...memberEntries];
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Add a member. Idempotent, and a no-op for an address that is already an env owner. */
export async function addReviewer(email: string, addedByEmail: string): Promise<void> {
  const normalized = normalize(email);
  if (!normalized || !EMAIL_SHAPE.test(normalized)) {
    throw new Error(`"${email}" is not a valid email address`);
  }
  if (reviewerEmails().has(normalized)) return;
  await db
    .insert(reviewer)
    .values({ email: normalized, addedByEmail: normalize(addedByEmail) })
    .onConflictDoNothing({ target: reviewer.email });
}

/** Remove a member. An env owner cannot be removed here, only by editing REVIEWER_EMAILS. */
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
