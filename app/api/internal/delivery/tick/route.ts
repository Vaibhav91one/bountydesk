import { randomUUID } from "node:crypto";

import { deliverOnce } from "@/lib/delivery/worker";
import { sweepExpiredLeases } from "@/lib/delivery/queue";
import { workerInternalSecret } from "@/lib/env";

// node:crypto and a Postgres socket both need the Node runtime.
export const runtime = "nodejs";

const MAX_DELIVERIES_PER_TICK = 25;

/**
 * Drains the outbox. Same shape as the jobs tick: bearer-secret gated, a fresh owner id per
 * call, a bounded loop rather than an unbounded drain, since a tick has to return.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${workerInternalSecret()}`) {
    return new Response("unauthorized", { status: 401 });
  }

  await sweepExpiredLeases();

  const owner = `delivery-tick-${randomUUID()}`;
  let processed = 0;

  while (processed < MAX_DELIVERIES_PER_TICK) {
    const deliveryId = await deliverOnce(owner);
    if (!deliveryId) break;
    processed += 1;
  }

  return Response.json({ processed });
}
