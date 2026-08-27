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

  const swept = await sweepExpiredLeases();

  const owner = `delivery-tick-${randomUUID()}`;
  const deadline = Date.now() + MAX_TICK_MS;
  let processed = 0;

  while (processed < MAX_DELIVERIES_PER_TICK && Date.now() < deadline) {
    const deliveryId = await deliverOnce(owner);
    if (!deliveryId) break;
    processed += 1;
  }

  return Response.json({ processed, swept });
}
