import { outcomeLabel, reportStateLabel, shouldShowOutcomeBadge } from "@/components/report-badges";
import type { CaseFile } from "@/lib/reports/case";
import { phaseOf } from "@/lib/reports/queue";

export type CaseStatusView = {
  id: string;
  state: string;
  phase: string;
  stateLabel: string;
  deliveryState: string | null;
  verdictOutcome: string | null;
  outcomeLabel: string | null;
  showOutcomeBadge: boolean;
  approvalDecision: string | null;
  awaitingVerdictId: string | null;
  updatedAt: string;
};

function caseStateLabel(file: CaseFile, deliveryState: string | null): string {
  if (file.state === "AWAITING_APPROVAL" && file.approval?.decision === "APPROVED") {
    return "Approved";
  }
  return reportStateLabel(file.state, deliveryState);
}

export function caseStatusView(file: CaseFile): CaseStatusView {
  const deliveryState = file.delivery?.state ?? null;
  const verdictOutcome = file.verdict?.outcome ?? null;

  return {
    id: file.id,
    state: file.state,
    phase: phaseOf(file.state),
    stateLabel: caseStateLabel(file, deliveryState),
    deliveryState,
    verdictOutcome,
    outcomeLabel: verdictOutcome ? outcomeLabel(verdictOutcome) : null,
    showOutcomeBadge: verdictOutcome ? shouldShowOutcomeBadge(file.state, verdictOutcome) : false,
    approvalDecision: file.approval?.decision ?? null,
    awaitingVerdictId: file.awaitingVerdictId,
    updatedAt: file.updatedAt.toISOString(),
  };
}
