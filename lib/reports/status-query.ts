import type { CaseLiveView } from "@/lib/reports/case-view";
import type { ToolCallView } from "@/lib/reports/tool-call-view";

/**
 * The client half of live state: query keys, fetchers, and how often each surface asks again.
 *
 * Deliberately free of server imports so it can be pulled into a client bundle. The terminal
 * state list is written out here rather than imported from lib/reports/states.ts, which reaches
 * into the Drizzle schema for its enum and would drag the pg driver along with it.
 */

const TERMINAL_STATES = ["DELIVERED", "DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"];

export function caseStatusQueryKey(reportId: string) {
  return ["report-status", reportId] as const;
}

export function caseToolCallsQueryKey(reportId: string) {
  return ["report-tool-calls", reportId] as const;
}

export function queueQueryKey() {
  return ["queue"] as const;
}

export function reportsIndexQueryKey() {
  return ["reports-index"] as const;
}

export function homeSummaryQueryKey() {
  return ["home-summary"] as const;
}

export function activeReportsQueryKey() {
  return ["active-reports"] as const;
}

/**
 * A reviewer whose session expired should end up at the login page, not watching a poll fail
 * quietly forever.
 *
 * The API routes answer 401 rather than redirecting, because a fetch follows a redirect into
 * the login page's HTML and response.json() then throws something that reads like a parse bug.
 * Sending the browser there is this side's job.
 */
export async function fetchLive<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });

  if (response.status === 401) {
    // A full load, not router.push. The session cookie is gone, so every cached query and the
    // app shell around them are describing a reviewer who is no longer signed in; throwing the
    // document away is the only way to be sure none of it survives into the next session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("Session expired");
  }

  if (!response.ok) {
    throw new Error(`Could not refresh (${response.status})`);
  }

  return response.json() as Promise<T>;
}

export function fetchCaseStatus(reportId: string): Promise<CaseLiveView> {
  return fetchLive<CaseLiveView>(`/api/reports/${reportId}/status`);
}

/** Live tool-call detail, keyed by the TrueForge call id a mirrored event carries. */
export function fetchCaseToolCalls(reportId: string): Promise<Record<string, ToolCallView>> {
  return fetchLive<Record<string, ToolCallView>>(`/api/reports/${reportId}/tool-calls`);
}

/**
 * How long to wait before asking again, or false to stop.
 *
 * Matched to how fast the thing being watched can actually move. The agent-session poller runs
 * on a 5000ms backoff and stretches to 30000ms once a pending call is verified
 * (lib/agent-sessions/poller.ts), so 1500ms is already ahead of the server during a live run,
 * and asking faster than that only spends database reads.
 *
 * AWAITING_APPROVAL is the exception in the other direction: nothing at all changes until a
 * human clicks, and that click updates the cache directly (lib/reports/live-keys.ts), so the
 * poll behind it can be lazy.
 */
export function caseRefetchInterval(status: CaseLiveView): number | false {
  // A queued send is the one thing that moves without anybody doing anything, so it outranks
  // the report's own state: DELIVERED with a delivery still PENDING is not finished.
  if (status.delivery?.state === "PENDING") return 1500;

  // Every attempt burned. The outbox will not pick this row up again and no amount of polling
  // will change that; it takes a human.
  if (
    status.delivery?.state === "FAILED" &&
    status.delivery.attempts >= status.delivery.maxAttempts
  ) {
    return false;
  }

  // The decision never reached the harness and has no attempts left. Nothing produces a
  // delivery row from here, so the report stays non-terminal forever and the poll below would
  // ask about it every 1.5 seconds for as long as the tab is open.
  if (
    status.handoff?.state === "FAILED" &&
    status.handoff.attempts >= status.handoff.maxAttempts &&
    !status.delivery
  ) {
    return false;
  }

  if (TERMINAL_STATES.includes(status.state)) return false;
  if (status.state === "AWAITING_APPROVAL") return 5000;

  return 1500;
}

/** Detail is only worth asking for while there are mirrored tool calls that could gain one. */
export function toolCallsRefetchInterval(status: CaseLiveView): number | false {
  return status.investigating ? 5000 : false;
}

export type ListPollItem = {
  state: string;
  deliveryState?: string | null;
  handoffFailed?: boolean;
};

/**
 * The queue and the reports index both keep a low watch even when every visible row is done.
 *
 * New reports can arrive after a screen has only terminal rows, and the first report can arrive
 * after an empty first paint. A visible moving row polls faster; a visible dead handoff does not
 * keep the list hot just because the report state itself is non-terminal.
 */
export function listRefetchInterval(items: ListPollItem[]): number {
  if (items.length === 0) return 4000;

  const hasMovingRow = items.some((item) => {
    if (item.deliveryState === "PENDING") return true;
    if (item.handoffFailed || item.deliveryState === "FAILED") return false;

    return !TERMINAL_STATES.includes(item.state);
  });

  return hasMovingRow ? 4000 : AMBIENT_REFETCH_MS;
}

/**
 * Surfaces with no report states to reason about: the home counts, and the sidebar's list while
 * it is on screen. Slower than a list, because nothing here is a run being watched.
 */
export const AMBIENT_REFETCH_MS = 10_000;
