import { currentSession } from "@/lib/auth/dal";
import { isReportId } from "@/lib/reports/case";
import {
  readChatStatus,
  reviewerChatEnabled,
} from "@/lib/reviewer-chat/queue";

export const runtime = "nodejs";

/** Separate no-store polling boundary for the reviewer chat panel. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!reviewerChatEnabled()) {
    return Response.json({ error: "reviewer chat is not enabled" }, { status: 404 });
  }

  const { id } = await context.params;
  if (!isReportId(id)) return Response.json({ error: "report not found" }, { status: 404 });

  const status = await readChatStatus(id);
  if (!status) return Response.json({ error: "report not found" }, { status: 404 });

  return Response.json(status, { headers: { "cache-control": "no-store" } });
}
