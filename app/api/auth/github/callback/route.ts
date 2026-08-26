import { cookies } from "next/headers";

import {
  STATE_COOKIE,
  appBaseUrl,
  identify,
  isSecureOrigin,
  statesMatch,
} from "@/lib/auth/oauth";
import { SESSION_COOKIE, cookieOptions, newSession, seal } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * Finish the login.
 *
 * The state check is the CSRF defence: without it anyone could hand the operator a link
 * that logs them into an attacker's GitHub account, and every approval afterwards would be
 * attributed to the wrong person. The cookie is cleared either way, so a state cannot be
 * replayed.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const jar = await cookies();

  const expected = jar.get(STATE_COOKIE)?.value;
  jar.delete(STATE_COOKIE);

  if (!statesMatch(expected, url.searchParams.get("state"))) {
    return Response.redirect(`${appBaseUrl()}/login?error=state`, 302);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return Response.redirect(`${appBaseUrl()}/login?error=denied`, 302);
  }

  const user = await identify(code);
  if (!user) {
    return Response.redirect(`${appBaseUrl()}/login?error=github`, 302);
  }

  jar.set(
    SESSION_COOKIE,
    seal(newSession(user.login, user.id)),
    cookieOptions(isSecureOrigin()),
  );

  return Response.redirect(`${appBaseUrl()}/connections`, 302);
}
