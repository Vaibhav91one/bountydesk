/**
 * The persistent-deployment worker loop, per docs/deployment.md's "Worker process" section:
 * a long-running Node process that drives the same claim functions the internal tick routes
 * call, continuously rather than once per HTTP request. This module is the testable core;
 * scripts/run-worker-daemon.ts is the thin entry point that wires it to the real queues.
 */

import type { Outcome } from "@/lib/worker-daemon/health";

type Logger = Pick<Console, "log" | "error">;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Rejects if `op` has not settled within `ms`, so a call that hangs becomes a failed iteration
 * rather than a silent one.
 *
 * The failure this exists for is a database call that never returns: Supabase's pooler can drop
 * a connection without a FIN, and the next query on that dead socket waits forever because the
 * server-side statement_timeout the pooler was told to enforce is not applied through it. A loop
 * awaiting such a call never records progress, so /healthz reads it as wedged and the platform
 * restarts the worker, over and over. Turning the hang into a throw lets the loop back off and
 * retry on a fresh connection, and lets /healthz see a loop that is failing (a visible, bounded
 * state the failure budget covers) rather than one gone silent.
 *
 * The abandoned `op` keeps running; postgres-js reaps the dead connection on its own later. This
 * is only for the loops whose one iteration is fast (a single-row claim, a sweep, one HTTP poll).
 * The jobs and build-onboarding claims legitimately run for minutes and are left unwrapped.
 */
async function withTimeout<T>(op: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not finish within ${ms}ms; treating it as a failed iteration`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

/**
 * Called once per completed iteration, whatever the iteration did. A loop stuck inside its own
 * claim is the one that goes quiet, so an idle and a failing iteration both count as alive. The
 * outcome is passed along because the two are not equally healthy: a loop that only ever throws
 * has stopped doing work as surely as one that hangs, and lib/worker-daemon/health.ts holds an
 * unbroken run of failures to its own budget.
 */
export type OnProgress = (name: string, outcome: Outcome) => void;

export type RunLoopOptions = {
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  jitter?: () => number;
  logger?: Logger;
  idleBackoffMs?: number;
  errorBackoffMs?: number;
  onProgress?: OnProgress;
  /** Fail an iteration that has not returned in this long, so a hung claim is a failed iteration
   *  rather than a silent one. Omit for a claim that legitimately runs for minutes (jobs, build
   *  onboarding), whose long silence is covered by a wide stall budget instead. */
  claimTimeoutMs?: number;
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
      const claim = claimOnce(opts.signal);
      claimedId = opts.claimTimeoutMs
        ? await withTimeout(claim, opts.claimTimeoutMs, `[${name}] claim`)
        : await claim;
    } catch (error) {
      if (opts.signal.aborted) return;
      logger.error(`[${name}] claim failed: ${errorMessage(error)}`);
      opts.onProgress?.(name, "failed");
      await sleep(withJitter(errorBackoffMs, jitter), opts.signal);
      continue;
    }

    if (opts.signal.aborted) return;
    opts.onProgress?.(name, "ok");

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
  onProgress?: OnProgress;
  /** Fail a sweep that has not returned in this long. A sweep is a single UPDATE, so any long
   *  wait is a hung connection, not real work. */
  sweepTimeoutMs?: number;
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
    let outcome: Outcome = "ok";
    try {
      const sweep = sweepOnce();
      await (opts.sweepTimeoutMs ? withTimeout(sweep, opts.sweepTimeoutMs, `[${name}]`) : sweep);
    } catch (error) {
      outcome = "failed";
      logger.error(`[${name}] sweep failed: ${errorMessage(error)}`);
    }
    opts.onProgress?.(name, outcome);
    if (opts.signal.aborted) return;
    await sleep(intervalMs, opts.signal);
  }
}

export type QueueSpec = {
  name: string;
  claimOnce: ClaimOnce;
  sweepOnce: () => Promise<unknown>;
  /** Fail this queue's claim if it has not returned in this long. Set for the queues whose claim
   *  is fast; omit for jobs and build-onboarding, whose claim runs the whole job or build. */
  claimTimeoutMs?: number;
};

export type RunDaemonOptions = {
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  jitter?: () => number;
  logger?: Logger;
  idleBackoffMs?: number;
  errorBackoffMs?: number;
  sweepIntervalMs?: number;
  onProgress?: OnProgress;
  /** Timeout applied to every sweep, since all sweeps are a single fast UPDATE. */
  sweepTimeoutMs?: number;
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
        onProgress: opts.onProgress,
        claimTimeoutMs: queue.claimTimeoutMs,
      }),
      runSweeper(`${queue.name}-sweep`, queue.sweepOnce, {
        signal: opts.signal,
        sleep: opts.sleep,
        logger: opts.logger,
        intervalMs: opts.sweepIntervalMs,
        onProgress: opts.onProgress,
        sweepTimeoutMs: opts.sweepTimeoutMs,
      }),
    ]),
  );
}
