import { randomUUID } from "node:crypto";

import { createTrueforgeAnalysisDriver } from "@/lib/analysis/trueforge-driver";
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

  const signal = AbortSignal.timeout(MAX_TICK_MS);
  const owner = `jobs-tick-${randomUUID()}`;
  const analysisDriver = createTrueforgeAnalysisDriver();
  let processed = 0;

  try {
    const swept = await raceAbort(sweepExpiredLeases(), signal);
    while (processed < MAX_JOBS_PER_TICK && !signal.aborted) {
      const jobId = await runOnce(owner, { analysis: analysisDriver, signal });
      if (!jobId) break;
      processed += 1;
    }
    return Response.json({ processed, swept });
  } catch (error) {
    if (signal.aborted) {
      return Response.json({ processed, error: "tick deadline exceeded" }, { status: 503 });
    }
    throw error;
  }
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  return Promise.race([operation, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}
