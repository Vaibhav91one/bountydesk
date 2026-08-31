import type { CaseStatusView } from "@/lib/reports/status-view";

export function caseStatusQueryKey(reportId: string) {
  return ["report-status", reportId] as const;
}

export async function fetchCaseStatus(reportId: string): Promise<CaseStatusView> {
  const response = await fetch(`/api/reports/${reportId}/status`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not refresh report status (${response.status})`);
  }
  return response.json() as Promise<CaseStatusView>;
}

export function shouldPollCaseStatus(status: CaseStatusView): boolean {
  if (status.deliveryState === "PENDING" || status.deliveryState === "SENDING") return true;
  return !["DELIVERED", "DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"].includes(status.state);
}
