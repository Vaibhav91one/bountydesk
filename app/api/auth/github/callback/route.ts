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
 * A callback that gets past the state check owns the flow, and spends both cookies on every
 * path from there, so neither can be replayed. One that fails the state check spends
 * nothing: it consumed no flow, and the cookies it can see may belong to a login the
 * operator started afterwards in the same browser. Clearing them there would let a stale
 * callback take the newer attempt down with it.
 *
 * Being a known GitHub user is not enough to get a session: the reviewer allowlist decides.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const secure = isSecureOrigin();
  const spent = [clearCookie(STATE_COOKIE, secure), clearCookie(VERIFIER_COOKIE, secure)];

  const loginError = (reason: string) => `${appBaseUrl()}/login?error=${reason}`;
  const fail = (reason: string) => redirect(loginError(reason), spent);

  if (!statesMatch(readCookie(request, STATE_COOKIE), url.searchParams.get("state"))) {
    return redirect(loginError("state"));
  }

  const verifier = readCookie(request, VERIFIER_COOKIE);
  if (!verifier) return fail("state");

  const code = url.searchParams.get("code");
  if (!code) return fail("denied");

  const user = await identify(code, verifier);
  if (!user) return fail("github");

  if (!isReviewer(user.id)) return fail("forbidden");

  return redirect(`${appBaseUrl()}/home`, [
    ...spent,
    setCookie(SESSION_COOKIE, seal(newSession(user.login, user.id)), {
      maxAge: SESSION_TTL_SECONDS,
      secure,
    }),
  ]);
}
