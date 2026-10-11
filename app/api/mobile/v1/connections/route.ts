import { connectionRows } from "@/app/(app)/connections/rows";
import { json, mobileAuth } from "@/lib/mobile/auth";

export const runtime = "nodejs";

/** The connections table, read-only: the same rows the web page renders. */
export async function GET(): Promise<Response> {
  const gate = await mobileAuth();
  if (!gate.ok) return gate.response;
  return json(await connectionRows());
}
