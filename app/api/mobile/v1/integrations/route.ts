import { integrationRows } from "@/app/(app)/integrations/rows";
import { listConnections } from "@/lib/github/connections";
import { json, mobileAuth } from "@/lib/mobile/auth";

export const runtime = "nodejs";

/** One row per platform, read-only: the same rows the web Integrations page renders. */
export async function GET(): Promise<Response> {
  const gate = await mobileAuth();
  if (!gate.ok) return gate.response;
  return json(integrationRows(await listConnections()));
}
