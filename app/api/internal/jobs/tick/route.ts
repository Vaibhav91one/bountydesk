import { randomUUID } from "node:crypto";

import { stubAnalysisDriver } from "@/lib/analysis/stub-driver";
import { workerInternalSecret } from "@/lib/env";
import { sweepExpiredLeases } from "@/lib/jobs/queue";
import { runOnce } from "@/lib/jobs/worker";

// node:crypto and a Postgres socket both need the Node runtime.
export const runtime = "nodejs";

const MAX_JOBS_PER_TICK = 25;

/**
 * Drives the inbound job queue. Nothing schedules this yet (no cron config exists in this
 * repo); a scheduler or the scripts under scripts/ call it with the bearer secret below. Each
 * call gets its own owner id, not a fixed string, so two overlapping ticks are distinguishable
 * in lease_owner if something needs debugging.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${workerInternalSecret()}`) {
    return new Response("unauthorized", { status: 401 });
  }

  await sweepExpiredLeases();

  const owner = `jobs-tick-${randomUUID()}`;
  let processed = 0;

  while (processed < MAX_JOBS_PER_TICK) {
    const jobId = await runOnce(owner, { analysis: stubAnalysisDriver });
    if (!jobId) break;
    processed += 1;
  }

  return Response.json({ processed });
}
