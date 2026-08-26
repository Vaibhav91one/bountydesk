import { cookies } from "next/headers";

import { SESSION_COOKIE, type Session, unseal } from "./session";

/** The logged-in operator, or null. Kept apart from session.ts so that stays testable. */
export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  return unseal(jar.get(SESSION_COOKIE)?.value);
}
