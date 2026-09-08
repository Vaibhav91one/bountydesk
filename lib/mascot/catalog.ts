export const MASCOT_STATES = [
  "idle",
  "ingest",
  "scanning",
  "reproducing",
  "canary-found",
  "awaiting-approval",
  "delivered",
  "celebrating",
  "denied",
  "out-of-scope",
  "infra-hiccup",
  "greeting",
  "chilling",
  "cowboy",
] as const;

export type MascotKey = (typeof MASCOT_STATES)[number];

/**
 * Which mascot stands for a report in each state.
 *
 * One map rather than one per screen. The board and the case file both draw Agent Bounty from
 * a report's state, and two tables would be two chances for the same report to be doing
 * different things depending on which page you were looking at.
 *
 * ANALYSIS_ONLY gets scanning: the report was read and weighed, which is the part that did
 * happen, and infra-hiccup is left for the lifecycle row where reproduction was skipped.
 * Cancelled and expired get idle, because nothing happened to them and nothing is going to.
 */
export const MASCOT_FOR_STATE: Record<string, MascotKey> = {
  TRIAGING: "ingest",
  REPRODUCING: "reproducing",
  ANALYSIS_ONLY: "scanning",
  AWAITING_APPROVAL: "awaiting-approval",
  DELIVERING: "delivered",
  DELIVERED: "celebrating",
  DENIED: "denied",
  OUT_OF_SCOPE: "out-of-scope",
  CANCELLED: "idle",
  EXPIRED: "idle",
};

export function mascotKeyForState(state: string): MascotKey {
  return MASCOT_FOR_STATE[state] ?? "idle";
}
