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
      className={cn(
        "size-2 shrink-0 rounded-full",
        TONE[phase] ?? TONE.closed,
        className,
      )}
    />
  );
}
