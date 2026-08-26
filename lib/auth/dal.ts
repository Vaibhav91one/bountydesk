import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { isReviewer } from "./reviewers";
import { SESSION_COOKIE, type Session, unseal } from "./session";

/**
 * Where authorization lives.
 *
 * next/headers is what keeps this server-side: importing it from a client component fails
 * the build, so no extra guard is needed.
 *
 * Every protected surface asks here rather than reading the cookie itself, so there is one
 * place that decides and one place to change. The allowlist is consulted on each request,
 * not just at login: a cookie lasts seven days, and taking someone off the list has to take
 * effect before that.
 *
 * cache() dedupes the work within a single render pass, not across requests.
 */
export const currentSession = cache(async (): Promise<Session | null> => {
  const jar = await cookies();
  const session = unseal(jar.get(SESSION_COOKIE)?.value);
  if (!session) return null;

  return isReviewer(session.userId) ? session : null;
});

/** For pages that must not render for anyone else. Redirects rather than returning null. */
export async function requireReviewer(): Promise<Session> {
  const session = await currentSession();
  if (!session) redirect("/login");

  return session;
}
