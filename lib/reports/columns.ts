import type { ReportState } from "@/lib/reports/states";

/**
 * The board's shape, with nothing behind it.
 *
 * Split out of queue.ts so a client component can ask which column a state belongs to without
 * dragging the query layer, and the pg driver behind it, into the browser bundle. queue.ts
 * re-exports both, so every existing import keeps working.
 */

/**
 * The board's columns, and the lifecycle states each one holds.
 *
 * REPRODUCING has no column of its own. It is a dead state under the agent-authored model:
 * the driver goes TRIAGING, then the agent turn, then AWAITING_APPROVAL, and nothing ever
 * moves a report into REPRODUCING (the case file documents the same thing). A dedicated
 * column for it would sit empty on every real board, so it folds in with the Analysis only
 * column, which is the post-triage investigation phase a stalled report actually rests in.
 * A stray REPRODUCING report would still show there rather than vanish.
 *
 * ANALYSIS_ONLY is reachable and stays. A report lands in it when reproduction could not run
 * at all, and a human decides what happens next.
 *
 * Every one of the ten states appears exactly once. A report that fell through the gaps would
 * be a report nobody can see.
 */
export const COLUMNS: { key: string; label: string; states: ReportState[] }[] = [
  { key: "triaging", label: "Triaging", states: ["TRIAGING"] },
  { key: "analysis-only", label: "Analysis only", states: ["REPRODUCING", "ANALYSIS_ONLY"] },
  { key: "awaiting-approval", label: "Awaiting approval", states: ["AWAITING_APPROVAL"] },
  { key: "delivered", label: "Delivered", states: ["DELIVERING", "DELIVERED"] },
  {
    key: "closed",
    // Four of the five terminal states, not all five. DELIVERED is terminal and deliberately
    // sits in its own column: a report that shipped a verdict and one that was denied, ruled
    // out of scope, cancelled or expired are the two answers a reviewer most needs to tell
    // apart, and a single Closed column holding both hides exactly that.
    //
    // This is how the board groups states, not what the lifecycle calls terminal.
    // TERMINAL_STATES in lib/reports/states.ts is the authority on that and still lists five.
    label: "Closed",
    states: ["DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"],
  },
];

/**
 * Which column a state belongs to, derived from COLUMNS rather than restated.
 *
 * The sidebar colours a report by its phase and the board colours a column by the same name, so
 * a second table here would be a second chance for the two to disagree.
 */
export function phaseOf(state: ReportState): string {
  const column = COLUMNS.find((c) => c.states.includes(state));
  // Unreachable while the test asserting every state is covered keeps passing, and cheaper to
  // answer honestly than to assert a non-null and be wrong later.
  return column?.key ?? "closed";
}
