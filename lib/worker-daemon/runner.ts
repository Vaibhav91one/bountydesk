/**
 * The persistent-deployment worker loop, per docs/deployment.md's "Worker process" section:
 * a long-running Node process that drives the same claim functions the internal tick routes
 * call, continuously rather than once per HTTP request. This module is the testable core;
 * scripts/run-worker-daemon.ts is the thin entry point that wires it to the real queues.
 */

type Logger = Pick<Console, "log" | "error">;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolves early when `signal` aborts, rather than always waiting out the full duration. A
 * SIGTERM during a 30-second sweeper interval (or any backoff) must not make shutdown wait for
 * that timer: most deployment platforms send SIGKILL well before then.
 */
async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** +/- 20% around the base, so four independently-started loops don't wake in lockstep. */
function withJitter(baseMs: number, jitter: () => number): number {
  const factor = 0.8 + jitter() * 0.4;
  return Math.round(baseMs * factor);
}

export type ClaimOnce = (signal: AbortSignal) => Promise<string | null>;

export type RunLoopOptions = {
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  jitter?: () => number;
  logger?: Logger;
  idleBackoffMs?: number;
  errorBackoffMs?: number;
};

/**
 * Drives one queue's claim function until the signal aborts.
 *
 * A `null` claim (nothing to do) backs off with jitter before retrying. A thrown claim is
 * logged and backed off exactly the same way, never propagated: one queue's transient failure
 * (a dropped DB connection, a TrueForge timeout) must never take the other three loops down
 * with it, since they share nothing but the process. Only `signal.aborted` stops the loop, and
 * it stops between claims, never mid-claim: a claim already in flight when the signal fires is
 * left to finish (or to have its lease recovered later by the sweeper), never abandoned by this
 * function walking away from it.
 */
export async function runLoop(
  name: string,
  claimOnce: ClaimOnce,
  opts: RunLoopOptions,
): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const jitter = opts.jitter ?? Math.random;
  const logger = opts.logger ?? console;
  const idleBackoffMs = opts.idleBackoffMs ?? 2000;
  const errorBackoffMs = opts.errorBackoffMs ?? 5000;

  while (!opts.signal.aborted) {
    let claimedId: string | null;
    try {
      claimedId = await claimOnce(opts.signal);
    } catch (error) {
      if (opts.signal.aborted) return;
      logger.error(`[${name}] claim failed: ${errorMessage(error)}`);
      await sleep(withJitter(errorBackoffMs, jitter), opts.signal);
      continue;
    }

    if (opts.signal.aborted) return;

    if (claimedId) {
      logger.log(`[${name}] claimed ${claimedId}`);
      continue;
    }

    await sleep(withJitter(idleBackoffMs, jitter), opts.signal);
  }
}

export type RunSweeperOptions = {
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  logger?: Logger;
  intervalMs?: number;
};

/**
 * Runs one queue's sweepExpiredLeases on its own cadence, independent of that queue's poll
 * loop: a crashed prior daemon can leave leases held past their expiry, and this is what
 * reclaims them for the loop above to pick back up. Sweeps once immediately (recovering
 * anything left over from before this process started), then on `intervalMs` after that.
 */
export async function runSweeper(
  name: string,
  sweepOnce: () => Promise<unknown>,
  opts: RunSweeperOptions,
): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const logger = opts.logger ?? console;
  const intervalMs = opts.intervalMs ?? 30_000;

  while (!opts.signal.aborted) {
    try {
      await sweepOnce();
    } catch (error) {
      logger.error(`[${name}] sweep failed: ${errorMessage(error)}`);
    }
    if (opts.signal.aborted) return;
    await sleep(intervalMs, opts.signal);
  }
}

export type QueueSpec = {
  name: string;
  claimOnce: ClaimOnce;
  sweepOnce: () => Promise<unknown>;
};

export type RunDaemonOptions = {
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  jitter?: () => number;
  logger?: Logger;
  idleBackoffMs?: number;
  errorBackoffMs?: number;
  sweepIntervalMs?: number;
};

/**
 * Starts one poll loop and one sweeper per queue, all sharing `opts.signal`. Resolves once
 * every loop has returned, which only happens after the signal aborts, so awaiting this is
 * the correct way to wait for a clean shutdown.
 */
export async function runDaemon(queues: QueueSpec[], opts: RunDaemonOptions): Promise<void> {
  await Promise.all(
    queues.flatMap((queue) => [
      runLoop(queue.name, queue.claimOnce, {
        signal: opts.signal,
        sleep: opts.sleep,
        jitter: opts.jitter,
        logger: opts.logger,
        idleBackoffMs: opts.idleBackoffMs,
        errorBackoffMs: opts.errorBackoffMs,
      }),
      runSweeper(`${queue.name}-sweep`, queue.sweepOnce, {
        signal: opts.signal,
        sleep: opts.sleep,
        logger: opts.logger,
        intervalMs: opts.sweepIntervalMs,
      }),
    ]),
  );
}
