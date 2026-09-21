/** A running agent session cannot hold the poll queue open beyond this wall-clock limit. */
export const DEFAULT_TURN_MAX_MS = 30 * 60 * 1000;

export function isOpenTurnStatus(status: string): boolean {
  return status === "RUNNING" || status === "INVESTIGATING";
}

/**
 * The session's created_at is the earliest timestamp already stored for an agent session. A
 * missing timestamp is treated as unknown rather than overdue, so an old row cannot be ended by
 * a made-up start time.
 */
export function isTurnOverdue(
  startedAt: Date | null | undefined,
  now: Date,
  maxMs: number = DEFAULT_TURN_MAX_MS,
): boolean {
  if (!startedAt || !Number.isFinite(maxMs) || maxMs < 0) return false;
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(now.getTime())) return false;
  return now.getTime() - startedAt.getTime() >= maxMs;
}
