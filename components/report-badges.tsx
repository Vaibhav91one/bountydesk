import { PhaseBadge } from "@/components/phase-dot";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
  ANALYSIS_ONLY: "Analysis only",
};

const OUTCOME_TONE: Record<string, string> = {
  REPRODUCED: "bg-emerald-500/15 text-emerald-400",
  NOT_REPRODUCED: "bg-sky-500/15 text-sky-300",
  INCONCLUSIVE: "bg-amber-500/15 text-amber-300",
  ANALYSIS_ONLY: "bg-phase-approval/15 text-phase-approval",
};

export function reportStateLabel(state: string, deliveryState?: string | null): string {
  return deliveryState === "FAILED" ? "Failed" : (STATE_LABEL[state] ?? state);
}

export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABEL[outcome] ?? outcome;
}

export function shouldShowOutcomeBadge(state: string, outcome: string | null): outcome is string {
  return Boolean(outcome) && !(state === "ANALYSIS_ONLY" && outcome === "ANALYSIS_ONLY");
}

export function ReportStateBadge({
  state,
  phase,
  deliveryState,
}: {
  state: string;
  phase: string;
  deliveryState?: string | null;
}) {
  if (deliveryState === "FAILED") {
    return <Badge variant="destructive">Failed</Badge>;
  }

  return <PhaseBadge phase={phase}>{reportStateLabel(state)}</PhaseBadge>;
}

export function ReportOutcomeBadge({ outcome }: { outcome: string }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", OUTCOME_TONE[outcome])}>
      {outcomeLabel(outcome)}
    </Badge>
  );
}
