import { appBaseUrl } from "@/lib/auth/oauth";

export const runtime = "nodejs";

/**
 * Where GitHub sends the operator after they install or reconfigure the App.
 *
 * It only redirects. The installation and its repositories are persisted from the signed
 * `installation` webhook, which is the one source we can authenticate; this callback is a
 * browser redirect and its query string is whatever the browser was handed.
 */
export async function GET(): Promise<Response> {
  return Response.redirect(`${appBaseUrl()}/integrations?installed=1`, 302);
}
