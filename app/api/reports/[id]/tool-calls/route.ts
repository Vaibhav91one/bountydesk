import { currentSession } from "@/lib/auth/dal";
import { isReportId } from "@/lib/reports/case";
import { readToolCalls } from "@/lib/reports/tool-calls";
import type { ToolCallView } from "@/lib/reports/tool-call-view";

export const runtime = "nodejs";

/**
 * Un-redacted tool-call detail for a report's investigation, keyed by TrueForge call id.
 *
 * Split off the case page's server render, which is where this used to live. It is a live call
 * to the harness with a five second abort, so every page request paid for a round trip whose
 * result only ever fills in a hover; on Vercel, where TRUEFORGE_URL is not set, it paid for a
 * throw. Behind its own query it fetches while the agent is working and stops when it is not.
 *
 * readToolCalls is resilient by construction: no session, no started turn, or any TrueForge
 * failure all give an empty map, and a row with no matching detail renders without a hover.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await currentSession();
  if (!session) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await context.params;
  if (!isReportId(id)) {
    return Response.json({ error: "report not found" }, { status: 404 });
  }

  const calls = await readToolCalls(id);
  const byId: Record<string, ToolCallView> = {};
  for (const call of calls) {
    byId[call.id] = {
      toolName: call.toolName,
      argumentsJson: call.argumentsJson,
      result: call.result,
    };
  }

  return Response.json(byId, { headers: { "cache-control": "no-store" } });
}
