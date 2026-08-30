import { Check, Minus } from "@phosphor-icons/react/ssr";

import { cn } from "@/lib/utils";

export type StepState = "done" | "current" | "pending" | "skipped";

/**
 * The badge above a lifecycle step.
 *
 * A ring with the step number, except when there is something better to say: a tick for a step
 * that finished, a dash for one the report went around. The current step's ring has a moving
 * arc, which is the only part of this that has to be looked at twice.
 *
 * Opaque on purpose. The connector between steps runs behind it, and a transparent badge would
 * let the line cross the number.
 */
export function StepBadge({ state, index }: { state: StepState; index: number }) {
  if (state === "done") {
    return (
      <span className="relative z-10 flex size-7 items-center justify-center rounded-full bg-phase-delivered text-background">
        <Check weight="bold" className="size-3.5" />
      </span>
    );
  }

  return (
    <span className="relative z-10 flex size-7 items-center justify-center rounded-full bg-background">
      <svg viewBox="0 0 28 28" className="absolute inset-0 size-full" aria-hidden="true">
        <circle cx="14" cy="14" r="13" fill="none" stroke="var(--border)" strokeWidth="2" />
        {state === "current" ? (
          // A quarter of the circumference, turning. The rest of the ring stays put underneath.
          <circle
            cx="14"
            cy="14"
            r="13"
            fill="none"
            stroke="var(--phase-approval)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="20 62"
            className="origin-center animate-spin motion-reduce:animate-none"
          />
        ) : null}
      </svg>
      <span
        className={cn(
          "relative text-meta tabular-nums",
          state === "current" ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {state === "skipped" ? <Minus className="size-3" /> : index}
      </span>
    </span>
  );
}
