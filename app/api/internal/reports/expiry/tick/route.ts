import { hasValidWorkerAuthorization } from "@/lib/internal/worker-auth";
import { sweepExpiredReports } from "@/lib/reports/expiry";

// A Postgres socket needs the Node runtime.
export const runtime = "nodejs";

const MAX_REPORTS_PER_TICK = 100;

/**
 * Expire abandoned reports on a schedule. Nothing schedules this yet (no cron config lives in
 * this repo); the same bearer secret as the jobs tick guards it, and the Zerops worker or a
 * script calls it. The sweep is bounded and idempotent, so an overlapping call at worst does
 * nothing on rows the first one already moved.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasValidWorkerAuthorization(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }

  const result = await sweepExpiredReports({ limit: MAX_REPORTS_PER_TICK });
  const expired = result.outcomes.filter((o) => o.status === "retired").length;
  return Response.json({ candidates: result.candidates, expired });
}
