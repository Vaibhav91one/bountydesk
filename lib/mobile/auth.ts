import { auth, currentUser } from "@clerk/nextjs/server";

import { currentSession } from "@/lib/auth/dal";
import { isReviewerWriter } from "@/lib/auth/reviewers";
import type { Session } from "@/lib/auth/session";

/**
 * Auth for /api/mobile/v1.
 *
 * The app sends its Clerk session token as `Authorization: Bearer <token>`. clerkMiddleware
 * (proxy.ts) verifies that header the same way it verifies the browser cookie, and it protects
 * no route and redirects nothing to /login, so auth() resolves for both. Clerk only issues a
 * handshake redirect for HTML navigations, never for a JSON fetch.
 *
 * Each request re-runs the reviewer allowlist through currentSession (nothing is cached across
 * requests), so taking someone off the list locks the app out on its next call. A write also
 * re-checks isReviewerWriter fresh, as requireWriteAccess does for the web.
 *
 * 401 means no valid token. 403 means a valid Clerk user who is not an allowlisted reviewer, or
 * a read-only reviewer attempting a write.
 */
export type MobileAuth = { ok: true; session: Session } | { ok: false; response: Response };

const NO_STORE = { "cache-control": "no-store" };

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function jsonError(error: string, status: number): Response {
  return json({ error }, status);
}

export async function mobileAuth(options: { write?: boolean } = {}): Promise<MobileAuth> {
  const { userId } = await auth();
  if (!userId) return { ok: false, response: jsonError("unauthenticated", 401) };

  const session = await currentSession();
  if (!session) return { ok: false, response: jsonError("not an allowlisted reviewer", 403) };

  if (options.write && !(await isReviewerWriter(session.email))) {
    return { ok: false, response: jsonError("read-only access", 403) };
  }
  return { ok: true, session };
}

export type MobileMe =
  | {
      allowlisted: true;
      login: string;
      email: string;
      avatarUrl: string | null;
      role: Session["role"];
    }
  | { allowlisted: false; login: string | null; email: string | null; avatarUrl: string | null };

/** Who the token belongs to. The one route that also answers for a signed-in non-reviewer. */
export async function mobileMe(): Promise<MobileMe | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const session = await currentSession();
  if (session) {
    return {
      allowlisted: true,
      login: session.login,
      email: session.email,
      avatarUrl: session.avatarUrl,
      role: session.role,
    };
  }

  const user = await currentUser();
  return {
    allowlisted: false,
    login: user?.username ?? user?.firstName ?? null,
    email: user?.primaryEmailAddress?.emailAddress ?? null,
    avatarUrl: user?.imageUrl ?? null,
  };
}
