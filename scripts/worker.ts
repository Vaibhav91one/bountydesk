import { hostname } from "node:os";

import { sweepExpiredLeases } from "@/lib/jobs/queue";
import { runOnce } from "@/lib/jobs/worker";

/**
 * Run the worker until interrupted.
 *
 *   npm run worker
 *
 * Concurrency one for the demo, which is a choice about the model and not about safety: the
 * lease is a real row lock, so running several of these is correct as it stands.
 */
const OWNER = `${hostname()}:${process.pid}`;
const IDLE_MS = 2000;
const SWEEP_EVERY = 30;

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n${signal}, finishing the current job then stopping`);
    running = false;
  });
}

async function main(): Promise<void> {
  console.log(`worker ${OWNER} started`);
  let ticks = 0;

  while (running) {
    if (ticks++ % SWEEP_EVERY === 0) {
      const { released, deadLettered } = await sweepExpiredLeases();
      if (released || deadLettered) {
        console.log(`swept: ${released} released, ${deadLettered} dead-lettered`);
      }
    }

    const jobId = await runOnce(OWNER);
    if (jobId) {
      console.log(`processed job ${jobId}`);
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
  }

  console.log("worker stopped");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
