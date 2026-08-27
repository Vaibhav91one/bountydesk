import { randomUUID } from "node:crypto";

import { deliverOnce } from "@/lib/delivery/worker";
import { sweepExpiredLeases } from "@/lib/delivery/queue";
import { hasValidWorkerAuthorization } from "@/lib/internal/worker-auth";

// node:crypto and a Postgres socket both need the Node runtime.
export const runtime = "nodejs";

const MAX_DELIVERIES_PER_TICK = 25;
const MAX_TICK_MS = 20_000;

/**
 * Drains the outbox. Same shape as the jobs tick: bearer-secret gated, a fresh owner id per
 * call, a bounded loop rather than an unbounded drain, since a tick has to return.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasValidWorkerAuthorization(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }

  const signal = AbortSignal.timeout(MAX_TICK_MS);
  const owner = `delivery-tick-${randomUUID()}`;
  let processed = 0;

  try {
    const swept = await raceAbort(sweepExpiredLeases(), signal);
    while (processed < MAX_DELIVERIES_PER_TICK && !signal.aborted) {
      const deliveryId = await deliverOnce(owner, { signal });
      if (!deliveryId) break;
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
