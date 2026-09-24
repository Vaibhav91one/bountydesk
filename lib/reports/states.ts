import { report } from "@/lib/db/schema";

/**
 * The report lifecycle graph: where the human-facing report has got to, and where it may
 * go next.
 *
 * Deliberately separate from job execution (lib/jobs/queue.ts), which tracks whether we
 * managed to process a delivery at all. Conflating them is how DEAD_LETTER ends up in a
 * reviewer's queue, so `DEAD_LETTER` is not a value here and never will be.
 */
export type ReportState = (typeof report.state.enumValues)[number];

export const TERMINAL_STATES = [
  "DELIVERED",
  "DENIED",
  "OUT_OF_SCOPE",
  "CANCELLED",
  "EXPIRED",
] as const;

export function isTerminal(state: ReportState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * The legal moves.
 *
 * Two rules are load-bearing rather than tidy. `OUT_OF_SCOPE` is reachable only from
 * `TRIAGING`, because it is a deterministic rejection made before any verdict exists: once a
 * report has been reproduced, refusing it is a human decision (`DENIED`), not a scope check.
 * And `ANALYSIS_ONLY` can move to delivery only from the approval path, because the analysis
 * packet is text we send to a reporter, and nothing reaches them unapproved.
 *
 * `NEEDS_DECISION` is where an outside email report waits before anything runs on it. The only
 * ways out are human ones: `TRIAGING` when a reviewer asks for the analysis-only run, and
 * `DENIED` when a reviewer rejects it or closes it as a duplicate. Nothing moves a report into
 * it but intake, so no edge leads here.
 *
 * There is no delivery-failure state. A failing send is retried by the outbox worker while
 * the report stays in `DELIVERING`, so a transient GitHub error is not a lifecycle event.
 *
 * Every non-terminal state can also go to CANCELLED or EXPIRED; that is added below rather
 * than repeated on each line.
 */
const ALLOWED_TRANSITIONS: Record<ReportState, readonly ReportState[]> = {
  TRIAGING: ["REPRODUCING", "ANALYSIS_ONLY", "OUT_OF_SCOPE"],
  NEEDS_DECISION: ["TRIAGING", "DENIED"],
  REPRODUCING: ["AWAITING_APPROVAL", "ANALYSIS_ONLY"],
  ANALYSIS_ONLY: ["AWAITING_APPROVAL", "DELIVERING", "DENIED", "REPRODUCING"],
  // The reviewer-driven edges back into REPRODUCING are taken only by a supersede
  // (lib/investigation-runs/recheck.ts), which has cleared the pending verdict and opened a
  // fresh run, so the report is investigating again. Nothing else may take these edges;
  // an approval or denial cannot un-approve a signed verdict.
  AWAITING_APPROVAL: ["DELIVERING", "DENIED", "REPRODUCING"],
  DELIVERING: ["DELIVERED"],
  DELIVERED: [],
  DENIED: [],
  OUT_OF_SCOPE: [],
  CANCELLED: [],
  EXPIRED: [],
};

const ABANDONMENT_STATES: readonly ReportState[] = ["CANCELLED", "EXPIRED"];

export function canTransition(from: ReportState, to: ReportState): boolean {
  if (isTerminal(from)) return false;
  if (ABANDONMENT_STATES.includes(to)) return true;

  return ALLOWED_TRANSITIONS[from].includes(to);
}
