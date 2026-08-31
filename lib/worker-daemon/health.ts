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
 */

export type HealthSnapshot = {
  ok: boolean;
  /** Loops past their budget, in the order they were registered. Empty when ok. */
  stale: string[];
  /** Milliseconds since each loop last finished an iteration. */
  ages: Record<string, number>;
};

export type Heartbeat = {
  record: (name: string, now?: number) => void;
  snapshot: (now?: number) => HealthSnapshot;
};

export type HeartbeatOptions = {
  /** Every loop the daemon runs. Seeded at startedAt so a loop that never ticks once is stale
   *  rather than simply absent from the snapshot. */
  names: readonly string[];
  startedAt: number;
  defaultBudgetMs: number;
  /** Per-loop overrides, for a queue whose single claim can legitimately outlast the default. */
  budgets?: Readonly<Record<string, number>>;
};

export function createHeartbeat({
  names,
  startedAt,
  defaultBudgetMs,
  budgets = {},
}: HeartbeatOptions): Heartbeat {
  const lastProgress = new Map<string, number>(names.map((name) => [name, startedAt]));

  return {
    record(name, now = Date.now()) {
      lastProgress.set(name, now);
    },

    snapshot(now = Date.now()) {
      const ages: Record<string, number> = {};
      const stale: string[] = [];

      for (const [name, at] of lastProgress) {
        const age = now - at;
        ages[name] = age;
        if (age > (budgets[name] ?? defaultBudgetMs)) stale.push(name);
      }

      return { ok: stale.length === 0, stale, ages };
    },
  };
}
