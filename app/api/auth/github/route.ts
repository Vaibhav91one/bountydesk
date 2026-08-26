import { cookies } from "next/headers";

import {
  STATE_COOKIE,
  authorizeUrl,
  isSecureOrigin,
  newState,
  stateCookieOptions,
} from "@/lib/auth/oauth";

export const runtime = "nodejs";

/** Start the login. The state goes in a cookie so the callback can prove it started here. */
export async function GET(): Promise<Response> {
  const state = newState();

  const jar = await cookies();
  jar.set(STATE_COOKIE, state, stateCookieOptions(isSecureOrigin()));

  return Response.redirect(authorizeUrl(state), 302);
}
