import { currentSession } from "@/lib/auth/dal";
import { isReportId } from "@/lib/reports/case";
import { readToolCalls } from "@/lib/reports/tool-calls";
import type { ToolCallView } from "@/lib/reports/tool-call-view";

export const runtime = "nodejs";

/**
 * Un-redacted tool-call detail for a report's investigation, keyed by TrueForge call id.
 *
 * Its own route rather than part of the case page's render, because it is a live call to the
 * harness with a five second abort whose result only ever fills in a hover: on its own query it
 * is fetched while the agent is working and not at all once it stops, and a page request never
 * waits on it. On Vercel, where TRUEFORGE_URL is not set, the call throws and the hover is
 * simply absent.
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
