import { clearCookie, readCookie, redirect, setCookie } from "@/lib/auth/cookies";
import {
  STATE_COOKIE,
  VERIFIER_COOKIE,
  appBaseUrl,
  identify,
  isSecureOrigin,
  statesMatch,
} from "@/lib/auth/oauth";
import { isReviewer } from "@/lib/auth/reviewers";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, newSession, seal } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * Finish the login.
 *
 * The state check is the CSRF defence: without it a crafted link could log the operator into
 * an attacker's GitHub account, and every approval afterwards would carry the wrong name in
 * the audit trail. The PKCE verifier has to be present too, so a code lifted from a redirect
 * cannot be redeemed elsewhere.
 *
 * Both cookies are cleared on every path, success or failure, so neither can be replayed.
 * Being a known GitHub user is not enough to get a session: the reviewer allowlist decides.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const secure = isSecureOrigin();
  const spent = [clearCookie(STATE_COOKIE, secure), clearCookie(VERIFIER_COOKIE, secure)];

  const fail = (reason: string) => redirect(`${appBaseUrl()}/login?error=${reason}`, spent);

  if (!statesMatch(readCookie(request, STATE_COOKIE), url.searchParams.get("state"))) {
    return fail("state");
  }

  const verifier = readCookie(request, VERIFIER_COOKIE);
  if (!verifier) return fail("state");

  const code = url.searchParams.get("code");
  if (!code) return fail("denied");

  const user = await identify(code, verifier);
  if (!user) return fail("github");

  if (!isReviewer(user.id)) return fail("forbidden");

  return redirect(`${appBaseUrl()}/connections`, [
    ...spent,
    setCookie(SESSION_COOKIE, seal(newSession(user.login, user.id)), {
      maxAge: SESSION_TTL_SECONDS,
      secure,
    }),
  ]);
}
