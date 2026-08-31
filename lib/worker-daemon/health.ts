/**
 * Liveness for the daemon's loops, as opposed to liveness for the process.
 *
 * A worker whose loops have all wedged still answers HTTP, still shows as ACTIVE, and still
 * claims nothing. That happened on 2026-08-31: every loop went silent at 13:43 UTC, an approved
 * verdict sat undelivered for seven minutes, and only a manual restart brought the claims back.
 * A health check that reports on the process rather than on the work cannot see that, so this
 * module records when each loop last completed an iteration and decides when that is too long
 * ago.
 *
 * Deciding "too long" is the whole of it, and the budget has to sit above the loop's own
 * cadence. An idle loop still finishes iterations (a null claim is progress, not silence), so
 * the only thing a budget has to clear is the longest legitimate gap between iterations: a
 * claim loop's error backoff, a sweeper's interval, and for the jobs queue the several minutes
 * a single claim can spend booting a sandbox and waiting for it to answer.
 *
 * Silence is not the only way a loop stops doing work. A loop whose every claim throws is
 * ticking as fast as its error backoff allows and would pass a check that only measures the gap
 * between iterations, while nothing it is there to do gets done: a worker that cannot reach
 * Postgres or TrueForge behaves exactly like this. So a loop also reports its outcome, and one
 * that has failed continuously past its failure budget is called stale too. A single failure
 * proves nothing (the queues retry through leases and backoff, which is where a transient error
 * belongs), which is why this is a duration and not a count.
 */

export type HealthSnapshot = {
  ok: boolean;
  /** Loops past a budget, in the order they were registered. Empty when ok. */
  stale: string[];
  /** Milliseconds since each loop last finished an iteration. */
  ages: Record<string, number>;
  /** For each loop whose iterations are currently all failing, how long that has been true.
   *  Absent for a loop whose last iteration succeeded, so an empty object means no queue is
   *  erroring. This is what names the dependency in the response when the check fails. */
  failingFor: Record<string, number>;
};

export type Heartbeat = {
  record: (name: string, now?: number, outcome?: Outcome) => void;
  snapshot: (now?: number) => HealthSnapshot;
};

/** What an iteration did. "failed" is a thrown claim or sweep; a claim that found nothing to do
 *  is "ok", since an idle queue is working correctly. */
export type Outcome = "ok" | "failed";

export type HeartbeatOptions = {
  /** Every loop the daemon runs. Seeded at startedAt so a loop that never ticks once is stale
   *  rather than simply absent from the snapshot. */
  names: readonly string[];
  startedAt: number;
  defaultBudgetMs: number;
  /** Per-loop overrides, for a queue whose single claim can legitimately outlast the default. */
  budgets?: Readonly<Record<string, number>>;
  /** How long a loop may fail every iteration before it counts as stale. Well above a blip the
   *  queue's own retries absorb, and below the point where an operator is reading logs to find
   *  out why nothing shipped. */
  failureBudgetMs: number;
};

export function createHeartbeat({
  names,
  startedAt,
  defaultBudgetMs,
  budgets = {},
  failureBudgetMs,
}: HeartbeatOptions): Heartbeat {
  const lastProgress = new Map<string, number>(names.map((name) => [name, startedAt]));
  // When the current unbroken run of failures began, for the loops that have one. A successful
  // iteration clears the entry, so the run always describes now rather than history.
  const failingSince = new Map<string, number>();

  return {
    record(name, now = Date.now(), outcome: Outcome = "ok") {
      lastProgress.set(name, now);
      if (outcome === "failed") {
        if (!failingSince.has(name)) failingSince.set(name, now);
      } else {
        failingSince.delete(name);
      }
    },

    snapshot(now = Date.now()) {
      const ages: Record<string, number> = {};
      const failingFor: Record<string, number> = {};
      const stale: string[] = [];

      for (const [name, at] of lastProgress) {
        const age = now - at;
        ages[name] = age;

        const since = failingSince.get(name);
        if (since !== undefined) failingFor[name] = now - since;

        const silent = age > (budgets[name] ?? defaultBudgetMs);
        const erroring = since !== undefined && now - since > failureBudgetMs;
        if (silent || erroring) stale.push(name);
      }

      return { ok: stale.length === 0, stale, ages, failingFor };
    },
  };
}
