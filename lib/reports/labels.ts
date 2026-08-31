const STATE_LABEL: Record<string, string> = {
  TRIAGING: "Triaging",
  REPRODUCING: "Reproducing",
  ANALYSIS_ONLY: "Analysis only",
  AWAITING_APPROVAL: "Awaiting approval",
  DELIVERING: "Delivering",
  DELIVERED: "Delivered",
  DENIED: "Denied",
  OUT_OF_SCOPE: "Out of scope",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

const OUTCOME_LABEL: Record<string, string> = {
  REPRODUCED: "Reproduced",
  NOT_REPRODUCED: "Not reproduced",
  INCONCLUSIVE: "Inconclusive",
  ANALYSIS_ONLY: "Analyzed",
};

/**
 * What a report's state and outcome are called, in one place.
 *
 * Apart from the badges that render them because the derived case view needs the same words
 * without needing React: a poll's JSON carries the label, so the server and the browser can
 * never disagree about what a state is called. components/report-badges.tsx re-exports all
 * three, so every existing import still resolves.
 *
 * A delivery that failed outranks the report's own state. The report stays in DELIVERING while
 * the outbox retries (there is no failure state in the lifecycle), and a badge reading
 * "Delivering" over a send that is not working is the wrong end of the truth.
 */
export function reportStateLabel(state: string, deliveryState?: string | null): string {
  return deliveryState === "FAILED" ? "Failed" : (STATE_LABEL[state] ?? state);
}

export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABEL[outcome] ?? outcome;
}

/** ANALYSIS_ONLY in both places is the state badge saying the same word twice. */
export function shouldShowOutcomeBadge(state: string, outcome: string | null): outcome is string {
  return Boolean(outcome) && !(state === "ANALYSIS_ONLY" && outcome === "ANALYSIS_ONLY");
}
