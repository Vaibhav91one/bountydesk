/**
 * Runs the outbox drain by hand, for local dev and the live smoke test.
 *
 *   npm run worker:delivery -- [count]
 *
 * There is no production approval trigger yet (A4 provides the native TrueForge gate), so an
 * `outbound_delivery` row only exists here after an approved publisher inserts it. A4 adds
 * that native TrueForge approval path.
 */
import { randomUUID } from "node:crypto";

import { deliverOnce } from "@/lib/delivery/worker";
import { sweepExpiredLeases } from "@/lib/delivery/queue";

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? "1");
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("usage: npm run worker:delivery -- [count]");
  }

  const { released, failed } = await sweepExpiredLeases();
  console.log(`swept: released=${released} failed=${failed}`);

  const owner = `local-delivery-${randomUUID()}`;
  for (let i = 0; i < count; i++) {
    const deliveryId = await deliverOnce(owner);
    if (!deliveryId) {
      console.log("nothing claimable");
      break;
    }
    console.log(`processed delivery ${deliveryId}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
