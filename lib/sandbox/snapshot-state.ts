/**
 * What a Daytona snapshot state means for provisioning, decided without touching the network.
 *
 * Daytona parks a snapshot as inactive after about two weeks without use, and a parked
 * snapshot refuses every create-from-snapshot call. The first run after the idle period then
 * fails with "sandbox could not be provisioned" even though one POST would have fixed it, so
 * provision.ts activates an inactive snapshot on demand and polls it back to active instead
 * of failing. This module holds the pure part of that: which states boot now, which need an
 * activate call first, which are still moving, and which are terminal.
 */

export type SnapshotAction = "ready" | "activate" | "wait" | "fail";

/**
 * Ceiling on one activation healing, from the first inactive read to giving up. Four minutes:
 * activation itself is quick, but the snapshot can pass through pulling or building on the way
 * back to active, and a bound keeps a stuck state from wedging a reproduction run.
 */
export const SNAPSHOT_ACTIVATION_TIMEOUT_MS = 240_000;

/** Gap between snapshot state re-reads while waiting. Matches the other polls in provision.ts. */
export const SNAPSHOT_ACTIVATION_POLL_MS = 3_000;

/**
 * Map a provider snapshot state to what provisioning should do. The state names come from
 * Daytona's SnapshotState enum (active, inactive, pending, pulling, building, snapshotting,
 * error, build_failed, removing).
 */
export function snapshotAction(state: string): SnapshotAction {
  switch (state) {
    case "active":
      return "ready";
    case "inactive":
      return "activate";
    case "pending":
    case "pulling":
    case "building":
    case "snapshotting":
      return "wait";
    case "error":
    case "build_failed":
    case "removing":
      return "fail";
    default:
      // A state this code has never seen is not something to boot from. Fail closed with the
      // state named rather than waiting out the whole activation bound on it.
      return "fail";
  }
}

/**
 * Whether an activation healing that started at `startedAtMs` has run out of time at `nowMs`.
 * Pure so the bound is unit-tested; provision.ts passes Date.now() for both.
 */
export function activationTimedOut(
  startedAtMs: number,
  nowMs: number,
  timeoutMs: number = SNAPSHOT_ACTIVATION_TIMEOUT_MS,
): boolean {
  return nowMs - startedAtMs >= timeoutMs;
}

/**
 * The `state[: reason]` suffix for snapshot failure messages. The provider's errorReason is
 * capped the way other provider text in this codebase is, and anything that is not a
 * non-blank string is left out rather than printed as "undefined".
 */
export function snapshotProblem(state: string, errorReason?: string | null): string {
  const reason = typeof errorReason === "string" ? errorReason.trim().slice(0, 300) : "";
  return reason ? `${state}: ${reason}` : state;
}
