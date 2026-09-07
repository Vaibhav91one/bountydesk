import { currentSession } from "@/lib/auth/dal";
import { listActiveReports } from "@/lib/reports/queue";

export const runtime = "nodejs";

/** The sidebar's short list of reports still in flight. No dates on it, so no serialization. */
export async function GET(): Promise<Response> {
  const session = await currentSession();
  if (!session) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  return Response.json(await listActiveReports(5), {
    headers: { "cache-control": "no-store" },
  });
}
