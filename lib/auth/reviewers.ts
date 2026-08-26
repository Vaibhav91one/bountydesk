import { requireEnv } from "@/lib/env";

import { type Session, unseal } from "./session";

/**
 * Who may operate BountyDesk.
 *
 * GitHub OAuth answers "which GitHub account is this", which is not the same question as
 * "may this person approve a verdict". Without a second answer, every GitHub account on the
 * internet is an operator. The MVP ships the smallest one that is real: a server-held
 * allowlist, checked on every protected request rather than only at login, so removing
 * someone takes effect before their seven-day cookie expires. Tenant membership and roles
 * are deliberately deferred.
 *
 * The list holds numeric user ids, not logins. A login can be changed or, once released,
 * taken by someone else; the id cannot.
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

export function isReviewer(userId: number): boolean {
  return reviewerIds().has(userId);
}

/**
 * The whole authorization decision for one cookie value, with no request plumbing attached.
 *
 * The DAL is this function plus a cookie read, which is what lets the interesting half be
 * tested directly: that a perfectly valid, unexpired cookie stops authorizing anything the
 * moment its user leaves the allowlist.
 */
export function authorizedSession(cookieValue: string | undefined): Session | null {
  const session = unseal(cookieValue);
  if (!session) return null;

  return isReviewer(session.userId) ? session : null;
}
