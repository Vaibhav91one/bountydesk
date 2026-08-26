import { redirect, setCookie } from "@/lib/auth/cookies";
import {
  OAUTH_COOKIE_TTL_SECONDS,
  STATE_COOKIE,
  VERIFIER_COOKIE,
  authorizeUrl,
  isSecureOrigin,
  newState,
  newVerifier,
} from "@/lib/auth/oauth";

export const runtime = "nodejs";

/**
 * Start the login.
 *
 * Two short-lived cookies go with it. The state proves the callback belongs to a login that
 * started here, and the PKCE verifier proves the code is being redeemed by the browser that
 * asked for it.
 */
export async function GET(): Promise<Response> {
  const state = newState();
  const verifier = newVerifier();
  const options = { maxAge: OAUTH_COOKIE_TTL_SECONDS, secure: isSecureOrigin() };

  return redirect(authorizeUrl(state, verifier), [
    setCookie(STATE_COOKIE, state, options),
    setCookie(VERIFIER_COOKIE, verifier, options),
  ]);
}
