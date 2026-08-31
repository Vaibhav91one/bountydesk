"use client";

import { useQuery } from "@tanstack/react-query";

import {
  caseStatusQueryKey,
  fetchCaseStatus,
  shouldPollCaseStatus,
} from "@/lib/reports/status-query";
import type { CaseStatusView } from "@/lib/reports/status-view";

export function CaseRealtimeStatus({
  reportId,
  initialStatus,
}: {
  reportId: string;
  initialStatus: CaseStatusView;
}) {
  const { data = initialStatus } = useQuery({
    queryKey: caseStatusQueryKey(reportId),
    queryFn: () => fetchCaseStatus(reportId),
    initialData: initialStatus,
    refetchInterval: (query) =>
      shouldPollCaseStatus(query.state.data ?? initialStatus) ? 1500 : false,
  });

  return data.stateLabel;
}
