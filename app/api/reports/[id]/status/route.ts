import { currentSession } from "@/lib/auth/dal";
import { caseLiveView } from "@/lib/reports/case-view";
import { isReportId, readCase } from "@/lib/reports/case";

export const runtime = "nodejs";

/**
 * The live case view, polled by the case page.
 *
 * 401 rather than requireReviewer's redirect to /login. A fetch follows a redirect, so a poll
 * on an expired session would receive the login page's HTML and fail on JSON.parse with an
 * error that says nothing about what actually happened. The client turns this status into a
 * navigation (lib/reports/status-query.ts).
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

  const file = await readCase(id);
  if (!file) {
    return Response.json({ error: "report not found" }, { status: 404 });
  }

  return Response.json(caseLiveView(file), {
    headers: { "cache-control": "no-store" },
  });
}
