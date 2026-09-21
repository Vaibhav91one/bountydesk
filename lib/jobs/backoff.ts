/**
 * Retry delays for inbound jobs.
 *
 * A short outage used to burn all five attempts in about a minute because the old
 * delay doubled from two seconds and capped at five minutes. These delays start at
 * thirty seconds and grow to fifteen minutes, so five attempts span about twenty
 * two minutes and a brief harness or sandbox outage no longer dead letters a job.
 *
 * Values stay small and deterministic so tests can assert exact delays and operators
 * can predict when a failed job becomes claimable again.
 */

export const FIRST_RETRY_DELAY_MS = 30_000;
export const SECOND_RETRY_DELAY_MS = 120_000;
export const THIRD_RETRY_DELAY_MS = 300_000;
export const MAX_BACKOFF_MS = 900_000;

/**
 * Delay before the next claim after the given attempt has failed.
 *
 * Attempt counts from one, the value claim() stored on the lease. Unknown or
 * non-positive input returns the smallest delay rather than zero, so a bad caller
 * cannot make a failed job immediately claimable.
 */
export function backoffMs(attempt: number): number {
  const n = Math.floor(attempt);
  if (!Number.isFinite(n) || n <= 1) return FIRST_RETRY_DELAY_MS;
  if (n === 2) return SECOND_RETRY_DELAY_MS;
  if (n === 3) return THIRD_RETRY_DELAY_MS;
  return MAX_BACKOFF_MS;
}

/**
 * Whether the given attempt count has exhausted its budget.
 *
 * Mirrors the fail() predicate (attempts >= max_attempts) so the SQL and any
 * JavaScript caller agree on when a job is buried rather than retried.
 */
export function shouldDeadLetter(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}
