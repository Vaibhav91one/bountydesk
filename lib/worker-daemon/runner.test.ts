import assert from "node:assert/strict";
import test from "node:test";

import { runDaemon, runLoop, runSweeper, type QueueSpec } from "./runner";

/** Resolves on the next microtask/macrotask tick, without a real wall-clock wait. */
function noWaitSleep(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function silentLogger() {
  return { log: () => undefined, error: () => undefined };
}

test("runLoop backs off between empty claims, but never sleeps after the claim that aborts it", async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  let calls = 0;

  const claimOnce = async () => {
    calls += 1;
    if (calls >= 3) controller.abort();
    return null;
  };

  await runLoop("t", claimOnce, {
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
      await noWaitSleep();
    },
    logger: silentLogger(),
    idleBackoffMs: 100,
  });

  assert.equal(calls, 3);
  // The loop checks the signal immediately after each claim, before deciding whether to
  // sleep. The third claim is the one that aborts, so it never reaches the sleep below it:
  // only the first two empty claims back off.
  assert.equal(sleeps.length, 2);
  for (const ms of sleeps) {
    assert.ok(ms >= 80 && ms <= 120, `expected ~100ms with jitter, got ${ms}`);
  }
});

test("runLoop keeps claiming immediately while work is available, no backoff", async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  let calls = 0;

  const claimOnce = async () => {
    calls += 1;
    if (calls >= 5) {
      controller.abort();
      return null;
    }
    return `job-${calls}`;
  };

  await runLoop("t", claimOnce, {
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    logger: silentLogger(),
  });

  assert.equal(calls, 5);
  // The four successful claims never sleep, and the fifth (empty, aborting) claim also never
  // reaches the sleep below it, for the same reason as the test above.
  assert.equal(sleeps.length, 0);
});

test("runLoop logs and backs off on a thrown claim rather than propagating", async () => {
  const controller = new AbortController();
  let calls = 0;
  const errors: string[] = [];

  const claimOnce = async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient failure");
    controller.abort();
    return null;
  };

  await runLoop("t", claimOnce, {
    signal: controller.signal,
    sleep: noWaitSleep,
    logger: { log: () => undefined, error: (msg: string) => errors.push(msg) },
    errorBackoffMs: 10,
  });

  assert.equal(calls, 2, "the loop must retry after a thrown claim, not stop");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /transient failure/);
});

test("runLoop never has more than one claim in flight at a time", async () => {
  const controller = new AbortController();
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;

  const claimOnce = async () => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await noWaitSleep();
    inFlight -= 1;
    if (calls >= 4) controller.abort();
    return `job-${calls}`;
  };

  await runLoop("t", claimOnce, { signal: controller.signal, logger: silentLogger() });

  assert.equal(maxInFlight, 1);
});

test("runLoop stops without claiming again once the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  await runLoop(
    "t",
    async () => {
      calls += 1;
      return null;
    },
    { signal: controller.signal, logger: silentLogger() },
  );

  assert.equal(calls, 0);
});

test("runSweeper sweeps immediately, then again on its own interval, independent of backoff", async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  let sweeps = 0;

  const sweepOnce = async () => {
    sweeps += 1;
    if (sweeps >= 3) controller.abort();
  };

  await runSweeper("t-sweep", sweepOnce, {
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    logger: silentLogger(),
    intervalMs: 30_000,
  });

  assert.equal(sweeps, 3);
  // Two sleeps between three sweeps: it sweeps first, then waits, sweeps, waits, sweeps, stops.
  assert.deepEqual(sleeps, [30_000, 30_000]);
});

test("runSweeper logs a failed sweep and keeps sweeping on its own cadence", async () => {
  const controller = new AbortController();
  let sweeps = 0;
  const errors: string[] = [];

  const sweepOnce = async () => {
    sweeps += 1;
    if (sweeps === 1) throw new Error("sweep failed once");
    controller.abort();
  };

  await runSweeper("t-sweep", sweepOnce, {
    signal: controller.signal,
    sleep: noWaitSleep,
    logger: { log: () => undefined, error: (msg: string) => errors.push(msg) },
  });

  assert.equal(sweeps, 2, "a failed sweep must not stop the sweeper");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sweep failed once/);
});

test("runDaemon runs every queue's loop and sweeper concurrently and resolves after shutdown", async () => {
  const controller = new AbortController();
  const claimed: Record<string, number> = { a: 0, b: 0 };
  const swept: Record<string, number> = { a: 0, b: 0 };

  const queue = (name: "a" | "b"): QueueSpec => ({
    name,
    claimOnce: async () => {
      claimed[name] += 1;
      return null;
    },
    sweepOnce: async () => {
      swept[name] += 1;
    },
  });

  setTimeout(() => controller.abort(), 20);

  await runDaemon([queue("a"), queue("b")], {
    signal: controller.signal,
    sleep: async () => {
      await noWaitSleep();
    },
    logger: silentLogger(),
    idleBackoffMs: 1,
    sweepIntervalMs: 1,
  });

  assert.ok(claimed.a > 0 && claimed.b > 0, "both queues' loops must have run");
  assert.ok(swept.a > 0 && swept.b > 0, "both queues' sweepers must have run");
});
