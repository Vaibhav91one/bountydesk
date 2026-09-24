/**
 * Which archived Daytona sandboxes are safe to delete by hand (scripts/cleanup-archived-sandboxes.ts).
 *
 * The targets are the harness's own agent sandboxes, which Daytona archives rather than deletes
 * and which BountyDesk never labels. Anything BountyDesk created carries a `bountydesk.*` label
 * and is left to the teardown sweeps that own it, and anything not archived may still be in use.
 * Age is the latest timestamp the provider reports, so a sandbox touched recently is kept even
 * if it was created long ago, and one with no readable timestamp is kept rather than guessed at.
 */
export type ListedSandbox = {
  id: string;
  state: string;
  labels?: Record<string, string> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastActivityAt?: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function selectArchivedForCleanup<T extends ListedSandbox>(
  sandboxes: T[],
  olderThanDays: number,
  now: Date,
): T[] {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new Error(`olderThanDays must be a non-negative number, got ${olderThanDays}`);
  }
  const cutoff = now.getTime() - olderThanDays * DAY_MS;

  return sandboxes.filter((sandbox) => {
    if (sandbox.state !== "archived") return false;
    if (Object.keys(sandbox.labels ?? {}).some((key) => key.startsWith("bountydesk."))) return false;

    const times = [sandbox.createdAt, sandbox.updatedAt, sandbox.lastActivityAt]
      .map((value) => (value ? Date.parse(value) : NaN))
      .filter(Number.isFinite);
    return times.length > 0 && Math.max(...times) < cutoff;
  });
}
