import { cookies } from "next/headers";

import { appBaseUrl } from "@/lib/auth/oauth";
import { SESSION_COOKIE } from "@/lib/auth/session";

export const runtime = "nodejs";

/** POST, not GET: a link in an issue comment must not be able to log the operator out. */
export async function POST(): Promise<Response> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);

  return Response.redirect(`${appBaseUrl()}/login`, 303);
}
