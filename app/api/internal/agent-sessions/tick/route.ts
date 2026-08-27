import { randomUUID } from "node:crypto";

import { hasValidWorkerAuthorization } from "@/lib/internal/worker-auth";
import { sweepExpiredLeases } from "@/lib/agent-sessions/queue";
import { pollOnce } from "@/lib/agent-sessions/poller";

// node:crypto and a Postgres socket both need the Node runtime.
export const runtime = "nodejs";

const MAX_SESSIONS_PER_TICK = 25;
const MAX_TICK_MS = 20_000;

/**
 * Drives the agent-session poller. Same shape as the jobs and delivery ticks: bearer-secret
 * gated, a fresh owner id per call, a bounded loop rather than an unbounded drain. Nothing
 * schedules this yet (no cron config exists in this repo); wiring real scheduling is a
 * documented fast-follow, same as those two.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasValidWorkerAuthorization(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }

  const signal = AbortSignal.timeout(MAX_TICK_MS);
  const owner = `agent-sessions-tick-${randomUUID()}`;
  let processed = 0;

  try {
    const swept = await raceAbort(sweepExpiredLeases(), signal);
    while (processed < MAX_SESSIONS_PER_TICK && !signal.aborted) {
      const sessionId = await pollOnce(owner, { signal });
      if (!sessionId) break;
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
