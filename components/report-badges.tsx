import { PhaseBadge } from "@/components/phase-dot";
import { Badge } from "@/components/ui/badge";
import { outcomeLabel, reportStateLabel } from "@/lib/reports/labels";
import { cn } from "@/lib/utils";

export {
  outcomeLabel,
  reportStateLabel,
  shouldShowOutcomeBadge,
} from "@/lib/reports/labels";

const OUTCOME_TONE: Record<string, string> = {
  REPRODUCED: "bg-emerald-500/15 text-emerald-400",
  NOT_REPRODUCED: "bg-sky-500/15 text-sky-300",
  INCONCLUSIVE: "bg-amber-500/15 text-amber-300",
  ANALYSIS_ONLY: "bg-phase-approval/15 text-phase-approval",
};

export function ReportStateBadge({
  state,
  phase,
  deliveryState,
  label,
}: {
  state: string;
  phase: string;
  deliveryState?: string | null;
  label?: string;
}) {
  if (deliveryState === "FAILED") {
    return <Badge variant="destructive">Failed</Badge>;
  }

  return <PhaseBadge phase={phase}>{label ?? reportStateLabel(state)}</PhaseBadge>;
}

export function ReportOutcomeBadge({ outcome }: { outcome: string }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", OUTCOME_TONE[outcome])}>
      {outcomeLabel(outcome)}
    </Badge>
  );
}
