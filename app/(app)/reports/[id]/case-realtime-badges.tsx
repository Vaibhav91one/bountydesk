"use client";

import { useQuery } from "@tanstack/react-query";

import { ReportOutcomeBadge, ReportStateBadge } from "@/components/report-badges";
import {
  caseStatusQueryKey,
  fetchCaseStatus,
  shouldPollCaseStatus,
} from "@/lib/reports/status-query";
import type { CaseStatusView } from "@/lib/reports/status-view";

export function CaseRealtimeBadges({
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

  return (
    <span className="flex flex-wrap items-center gap-1.5 text-body text-foreground">
      <ReportStateBadge
        state={data.state}
        phase={data.phase}
        deliveryState={data.deliveryState}
        label={data.stateLabel}
      />
      {data.verdictOutcome && data.showOutcomeBadge ? (
        <ReportOutcomeBadge outcome={data.verdictOutcome} />
      ) : null}
    </span>
  );
}
