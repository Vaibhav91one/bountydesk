import { currentSession } from "@/lib/auth/dal";
import { listQueue } from "@/lib/reports/queue";
import { queueColumnViews } from "@/lib/reports/queue-view";

export const runtime = "nodejs";

/** The review board's columns, polled by the board. Same read the page does for first paint. */
export async function GET(): Promise<Response> {
  const session = await currentSession();
  if (!session) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  return Response.json(queueColumnViews(await listQueue()), {
    headers: { "cache-control": "no-store" },
  });
}
