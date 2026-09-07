import { CircleNotch } from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The one place a phase turns into a colour.
 *
 * Class strings live here rather than in lib/reports/queue.ts, which stays free of anything
 * about how the pipeline looks. They are written out in full because Tailwind reads source for
 * literal class names, so a template built from the phase key would compile to nothing.
 */
const TONE: Record<string, string> = {
  triaging: "bg-phase-triaging",
  reproducing: "bg-phase-reproducing",
  "analysis-only": "bg-phase-analysis",
  "awaiting-approval": "bg-phase-approval",
  delivered: "bg-phase-delivered",
  closed: "bg-phase-closed",
};

/** The same six colours as ink rather than fill, for anything that is not a dot. */
const INK: Record<string, string> = {
  triaging: "text-phase-triaging",
  reproducing: "text-phase-reproducing",
  "analysis-only": "text-phase-analysis",
  "awaiting-approval": "text-phase-approval",
  delivered: "text-phase-delivered",
  closed: "text-phase-closed",
};

/**
 * The same six colours as a filled pill: the phase as ink on a dark mix of itself.
 *
 * Written out in full for the reason the other two maps are. A template built from the phase
 * key compiles to nothing, because Tailwind reads source for literal class names.
 */
const FILL: Record<string, string> = {
  triaging: "bg-phase-triaging/15 text-phase-triaging",
  reproducing: "bg-phase-reproducing/15 text-phase-reproducing",
  "analysis-only": "bg-phase-analysis/15 text-phase-analysis",
  "awaiting-approval": "bg-phase-approval/15 text-phase-approval",
  delivered: "bg-phase-delivered/15 text-phase-delivered",
  closed: "bg-phase-closed/15 text-phase-closed",
};

/**
 * A state, in its phase's colour.
 *
 * Unlike PhaseDot this carries the words, so it is not aria-hidden: it is the label, not a
 * decoration beside one.
 */
export function PhaseBadge({
  phase,
  children,
  className,
}: {
  phase: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent", FILL[phase] ?? FILL.closed, className)}
    >
      {children}
    </Badge>
  );
}

/**
 * A spinner in the phase's colour, for a report something is actively doing.
 *
 * It replaces the dot rather than joining it. A spinner already says "in progress", and a
 * pulsing dot beside one is two things saying it at once.
 */
export function PhaseSpinner({ phase, className }: { phase: string; className?: string }) {
  return (
    <CircleNotch
      aria-hidden="true"
      className={cn(
        "size-3.5 shrink-0 animate-spin motion-reduce:animate-none",
        INK[phase] ?? INK.closed,
        className,
      )}
    />
  );
}

/**
 * A phase's colour, and nothing else.
 *
 * aria-hidden throughout: every dot in this product sits beside a label that says the same
 * thing in words, and a screen reader announcing an unlabelled bullet adds noise, not meaning.
 */
export function PhaseDot({ phase, className }: { phase: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", TONE[phase] ?? TONE.closed, className)}
    />
  );
}
