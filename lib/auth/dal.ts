import { cache } from "react";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";

import { isReviewerEmail, isReviewerWriter, reviewerRole } from "./reviewers";
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
  let reviewerEmail: string | undefined;
  for (const email of candidates) {
    if (await isReviewerEmail(email)) {
      reviewerEmail = email;
      break;
    }
  }
  if (!reviewerEmail) return null;

  // The address just matched isReviewerEmail, so this is never null in practice; "member" is a
  // safe floor rather than a silent escalation if the two ever raced.
  const role = (await reviewerRole(reviewerEmail)) ?? "member";

  const login = user.username ?? user.firstName ?? reviewerEmail;
  return { login, email: reviewerEmail, avatarUrl: user.imageUrl ?? null, role };
});

/** The Clerk user id behind this request, allowlisted or not. Null when nobody is signed in. */
export async function signedInUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId;
}

/** Display fields of the signed-in Clerk user, for answering "who is this" about a non-reviewer. */
export async function clerkProfile(): Promise<{
  login: string | null;
  email: string | null;
  avatarUrl: string | null;
}> {
  const user = await currentUser();
  return {
    login: user?.username ?? user?.firstName ?? null,
    email: user?.primaryEmailAddress?.emailAddress ?? null,
    avatarUrl: user?.imageUrl ?? null,
  };
}

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

export type WriteAccessResult = { ok: true; session: Session } | { ok: false; error: string };

/**
 * For a server action that mutates something: the same session requireReviewer gets, plus a
 * fresh (not session-cached) check that this reviewer can write. A server action returns a
 * typed result rather than redirecting, so the denial does too, in the same
 * `{ ok: false, error }` shape every action already returns. Checked fresh rather than trusting
 * session.role so a demotion mid-session is enforced on the very next write, not the next
 * sign-in.
 */
export async function requireWriteAccess(): Promise<WriteAccessResult> {
  const session = await requireReviewer();
  if (!(await isReviewerWriter(session.email))) {
    return { ok: false, error: "This reviewer has read-only access." };
  }
  return { ok: true, session };
}
