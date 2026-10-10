import { json, jsonError, mobileMe } from "@/lib/mobile/auth";

export const runtime = "nodejs";

/** Who the token belongs to and whether they are an allowlisted reviewer. 401 only without a token. */
export async function GET(): Promise<Response> {
  const me = await mobileMe();
  return me ? json(me) : jsonError("unauthenticated", 401);
}
