"use client";

import { useQuery } from "@tanstack/react-query";

import { ReportOutcomeBadge, ReportStateBadge } from "@/components/report-badges";
import type { CaseLiveView } from "@/lib/reports/case-view";
import {
  caseRefetchInterval,
  caseStatusQueryKey,
  fetchCaseStatus,
} from "@/lib/reports/status-query";

/**
 * The state and outcome badges in the page header.
 *
 * Separate from CaseView because it sits inside the header's identity block, beside the title
 * and the reporter, rather than in the body. It shares the query key, so the two mount one
 * request between them and can never show different states at the same moment.
 */
export function CaseRealtimeBadges({
  reportId,
  initialStatus,
}: {
  reportId: string;
  initialStatus: CaseLiveView;
}) {
  const { data = initialStatus } = useQuery({
    queryKey: caseStatusQueryKey(reportId),
    queryFn: () => fetchCaseStatus(reportId),
    initialData: initialStatus,
    refetchInterval: (query) => caseRefetchInterval(query.state.data ?? initialStatus),
  });

  return (
    <span className="flex flex-wrap items-center gap-1.5 text-body text-foreground">
      <ReportStateBadge
        state={data.state}
        phase={data.phase}
        deliveryState={data.deliveryState}
        failed={data.failed}
        label={data.stateLabel}
      />
      {data.verdictOutcome && data.showOutcomeBadge ? (
        <ReportOutcomeBadge outcome={data.verdictOutcome} />
      ) : null}
    </span>
  );
}
