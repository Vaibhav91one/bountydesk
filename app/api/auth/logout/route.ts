import { clearCookie, redirect } from "@/lib/auth/cookies";
import { appBaseUrl, isSecureOrigin } from "@/lib/auth/oauth";
import { SESSION_COOKIE } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * Sign out.
 *
 * POST-only stops a link in an issue comment logging the operator out, but not a form on a
 * page they visit, so the Origin has to match ours exactly. Deleting a session is not
 * destructive enough to warrant a synchronizer token; a strict origin check is.
 */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== appBaseUrl()) {
    return new Response("cross-origin logout refused", { status: 403 });
  }

  return redirect(`${appBaseUrl()}/login`, [clearCookie(SESSION_COOKIE, isSecureOrigin())], 303);
}
