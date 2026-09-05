"use client";

import { useQuery } from "@tanstack/react-query";

import type { CaseLiveView } from "@/lib/reports/case-view";
import {
  caseRefetchInterval,
  caseStatusQueryKey,
  caseToolCallsQueryKey,
  fetchCaseStatus,
  fetchCaseToolCalls,
  toolCallsRefetchInterval,
} from "@/lib/reports/status-query";

import { ApprovalDialog } from "./approval-dialog";

/**
 * The approval button, and whether there is one.
 *
 * Only where there is a pending call an approval could answer: a report sitting in
 * AWAITING_APPROVAL with nothing pending would open a dialog whose buttons refuse.
 *
 * Deciding that here rather than on the server is what makes the button behave. It has to appear
 * on its own when a run finishes while a reviewer is watching the page, and it has to go away the
 * moment a decision lands. It reads the same query key as CaseView below it, so the button
 * leaving and the signed record arriving are one render, not two seconds apart.
 */
export function CaseApproval({
  reportId,
  initial,
}: {
  reportId: string;
  initial: CaseLiveView;
}) {
  const { data: status = initial } = useQuery({
    queryKey: caseStatusQueryKey(reportId),
    queryFn: () => fetchCaseStatus(reportId),
    initialData: initial,
    refetchInterval: (query) => caseRefetchInterval(query.state.data ?? initial),
  });

  const { data: details } = useQuery({
    queryKey: caseToolCallsQueryKey(reportId),
    queryFn: () => fetchCaseToolCalls(reportId),
    enabled: status.eventCount > 0,
    refetchInterval: () => toolCallsRefetchInterval(status),
  });

  if (!status.awaitingVerdictId || !status.verdict) return null;

  return (
    <ApprovalDialog
      reportId={reportId}
      verdictId={status.awaitingVerdictId}
      contentHash={status.verdict.contentHash}
      payload={status.verdict.payload}
      payloadArtifactId={status.verdict.payloadArtifactId}
      findingsArtifactId={status.verdict.findingsArtifactId}
      outcome={status.verdict.outcome}
      outcomeLabel={status.verdict.outcomeLabel}
      summary={status.verdict.summary}
      revision={status.verdict.revision}
      destination={status.destination}
      targetName={status.target?.name ?? null}
      reproductionRan={status.verdict.reproductionRan}
      findings={status.verdict.findings}
      speaker="awaiting-approval"
      speakerScope="approval-speaker"
      chatMascot="greeting"
      chatMascotScope="approval-chat"
      events={status.steps.flatMap((step) => step.events)}
      details={details}
    />
  );
}
