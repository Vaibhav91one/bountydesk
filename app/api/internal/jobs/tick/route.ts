import { randomUUID } from "node:crypto";

import { stubAnalysisDriver } from "@/lib/analysis/stub-driver";
import { hasValidWorkerAuthorization } from "@/lib/internal/worker-auth";
import { sweepExpiredLeases } from "@/lib/jobs/queue";
import { runOnce } from "@/lib/jobs/worker";

// node:crypto and a Postgres socket both need the Node runtime.
export const runtime = "nodejs";

const MAX_JOBS_PER_TICK = 25;
const MAX_TICK_MS = 20_000;

/**
 * Drives the inbound job queue. Nothing schedules this yet (no cron config exists in this
 * repo); a scheduler or the scripts under scripts/ call it with the bearer secret below. Each
 * call gets its own owner id, not a fixed string, so two overlapping ticks are distinguishable
 * in lease_owner if something needs debugging.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasValidWorkerAuthorization(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }

  const swept = await sweepExpiredLeases();

  const owner = `jobs-tick-${randomUUID()}`;
  const deadline = Date.now() + MAX_TICK_MS;
  let processed = 0;

  while (processed < MAX_JOBS_PER_TICK && Date.now() < deadline) {
    const jobId = await runOnce(owner, { analysis: stubAnalysisDriver });
    if (!jobId) break;
    processed += 1;
  }

  return Response.json({ processed, swept });
}
