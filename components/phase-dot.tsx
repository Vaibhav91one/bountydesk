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
export function PhaseDot({
  phase,
  running = false,
  className,
}: {
  phase: string;
  /** Adds the ping. Only for phases something is actively doing, never for one that waits. */
  running?: boolean;
  className?: string;
}) {
  const tone = TONE[phase] ?? TONE.closed;

  if (!running) {
    return (
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", tone, className)} />
    );
  }

  return (
    <span aria-hidden="true" className={cn("relative flex size-2 shrink-0", className)}>
      {/* Two dots: one still, one expanding out of it. animate-ping scales and fades, so a
          single element would spend most of the cycle invisible. */}
      <span
        className={cn(
          "absolute inline-flex size-full animate-ping rounded-full opacity-70 motion-reduce:hidden",
          tone,
        )}
      />
      <span className={cn("relative inline-flex size-full rounded-full", tone)} />
    </span>
  );
}
