import { cache } from "react";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";

import { isReviewerEmail } from "./reviewers";
import type { Session } from "./session";

/**
 * Where authorization lives.
 *
 * Clerk answers who is signed in; this is the one place that turns that into a BountyDesk session
 * and applies the reviewer allowlist. Every protected surface asks here rather than reading Clerk
 * directly, so there is one place that decides and one place to change. The allowlist is consulted
 * on each request, not just at login: taking someone off the list has to take effect at once.
 *
 * A signed-in account that is not on the allowlist gets `null` here, exactly like a signed-out
 * one, so no non-reviewer ever holds a session. `requireReviewer` separates the two cases only to
 * send them to the right place.
 *
 * cache() dedupes the work within a single render pass, not across requests.
 */
export const currentSession = cache(async (): Promise<Session | null> => {
  const { userId } = await auth();
  if (!userId) return null;

  const user = await currentUser();
  if (!user) return null;

  // One person, one Clerk user, possibly several linked accounts (Google plus a GitHub whose email
  // may differ). Authorize if any verified email is on the allowlist, so linking a differently
  // addressed GitHub still works. Clerk only lets you attach an email you have verified, so this
  // cannot be spoofed. The session email is the matched one, which keeps the downstream
  // isReviewerEmail(session.email) checks consistent.
  const verified = user.emailAddresses.filter((e) => e.verification?.status === "verified");
  const candidates = (verified.length ? verified : user.emailAddresses).map((e) => e.emailAddress);
  const reviewerEmail = candidates.find((email) => isReviewerEmail(email));
  if (!reviewerEmail) return null;

  const login = user.username ?? user.firstName ?? reviewerEmail;
  return { login, email: reviewerEmail, avatarUrl: user.imageUrl ?? null };
});

/**
 * For pages that must not render for anyone else. A signed-out visitor goes to sign-in; a signed-in
 * account that is not a reviewer goes to the not-authorized page rather than back to sign-in, which
 * would loop because they are already authenticated.
 */
export async function requireReviewer(): Promise<Session> {
  const session = await currentSession();
  if (session) return session;

  const { userId } = await auth();
  redirect(userId ? "/not-authorized" : "/login");
}
