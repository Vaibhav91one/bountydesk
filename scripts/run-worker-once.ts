/**
 * Runs the inbound job queue by hand, for local dev and the live smoke test: no cron config
 * exists in this repo yet, so this is how a job actually gets processed outside a test.
 *
 *   npm run worker:jobs -- [count]
 *
 * `count` defaults to 1. Each invocation gets its own owner id, matching the tick route.
 */
import { randomUUID } from "node:crypto";

import { createTrueforgeAnalysisDriver } from "@/lib/analysis/trueforge-driver";
import { sweepExpiredLeases } from "@/lib/jobs/queue";
import { runOnce } from "@/lib/jobs/worker";

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? "1");
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("usage: npm run worker:jobs -- [count]");
  }

  const { released, deadLettered } = await sweepExpiredLeases();
  console.log(`swept: released=${released} deadLettered=${deadLettered}`);

  const owner = `local-jobs-${randomUUID()}`;
  const analysis = createTrueforgeAnalysisDriver();
  for (let i = 0; i < count; i++) {
    const jobId = await runOnce(owner, { analysis });
    if (!jobId) {
      console.log("nothing claimable");
      break;
    }
    console.log(`processed job ${jobId}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
