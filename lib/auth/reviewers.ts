import { requireEnv } from "@/lib/env";

/**
 * Who may operate BountyDesk.
 *
 * Sign-in (Clerk, via Google or GitHub) answers "which account is this", which is not the same
 * question as "may this person approve a verdict". Without a second answer, every account on the
 * internet is an operator. The allowlist is that second answer, checked on every protected
 * request rather than only at login, so removing someone takes effect at once.
 *
 * Two allowlists, two audiences. The dashboard authorizes by email, because that is the identity
 * Clerk resolves for a Google or GitHub sign-in. The GitHub-issue `/reproduce` gate authorizes by
 * GitHub numeric id, because it matches a webhook actor and never involves a dashboard login. They
 * are deliberately independent.
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

/** Dashboard authorization: does this signed-in email belong to a reviewer? */
export function isReviewerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return reviewerEmails().has(email.trim().toLowerCase());
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
