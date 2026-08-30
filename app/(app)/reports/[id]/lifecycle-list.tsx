"use client";

import { useState } from "react";
import { CaretDown } from "@phosphor-icons/react/ssr";

import { cn } from "@/lib/utils";

import { StepBadge, type StepState } from "./lifecycle-step";

export type LifecycleStep = {
  key: string;
  label: string;
  note: string;
  state: StepState;
  /** Inline SVG for the mascot standing in for this phase, id-prefixed by the page. */
  mascot: string;
  events: { seq: number; type: string; at: string }[];
};

/**
 * The pipeline as a list, one row per phase, each opening onto the events recorded during it.
 *
 * Ported from a task-rows component that carried its own token system. What is worth keeping
 * is the grammar: a status badge, a label, a count on the right, and a row that expands over a
 * grid-template-rows transition rather than a height one, so it animates without anybody
 * measuring anything.
 *
 * A row with no events does not open. A chevron that turns and reveals nothing is worse than
 * no chevron.
 */
export function LifecycleList({ steps }: { steps: LifecycleStep[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  return (
    // h-full and justify-between: the panel is stretched to the diagram beside it, and rows
    // bunched at the top under half a panel of nothing reads as a list that failed to load.
    <ol className="flex h-full flex-col justify-between">
      {steps.map((step, index) => {
        const expandable = step.events.length > 0;
        const isOpen = expandable && (open[step.key] ?? false);

        return (
          <li
            key={step.key}
            className="animate-step-in border-b border-border/50 last:border-b-0 motion-reduce:animate-none"
            style={{ animationDelay: `${index * 70}ms` }}
          >
            <button
              type="button"
              disabled={!expandable}
              aria-expanded={expandable ? isOpen : undefined}
              onClick={() => setOpen((current) => ({ ...current, [step.key]: !isOpen }))}
              className="flex w-full items-center gap-3 px-4 py-4 text-left enabled:hover:bg-muted/40 disabled:cursor-default"
            >
              <StepBadge state={step.state} index={index + 1} />

              {/* Agent Bounty doing the thing the row names. A phase nobody reached is drawn
                  faint rather than swapped for a placeholder: it is the same step, not yet. */}
              <span
                aria-hidden="true"
                className={cn(
                  "size-12 shrink-0 [&>svg]:block [&>svg]:size-full",
                  step.state === "pending" && "opacity-40",
                )}
                dangerouslySetInnerHTML={{ __html: step.mascot }}
              />

              <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
                {step.label}
              </span>

              <span className="shrink-0 text-meta text-muted-foreground">{step.note}</span>

              <CaretDown
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform duration-300",
                  isOpen && "rotate-180",
                  !expandable && "invisible",
                )}
              />
            </button>

            <div
              className="grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
              style={{ gridTemplateRows: isOpen ? "1fr" : "0fr", opacity: isOpen ? 1 : 0 }}
            >
              <div className="overflow-hidden">
                {/* The rule under the badge continues the column the badges make, so an open
                    row reads as hanging off its own step rather than floating between two. */}
                <div className="mb-3 grid grid-cols-[28px_1fr] gap-3 px-4">
                  <span aria-hidden="true" className="mx-auto h-full w-px bg-border/50" />
                  <ul className="flex flex-col gap-1.5">
                    {step.events.map((event) => (
                      <li key={event.seq} className="flex items-baseline justify-between gap-4">
                        <span className="min-w-0 truncate text-meta text-muted-foreground">
                          {event.type}
                        </span>
                        <span className="shrink-0 font-mono text-meta tabular-nums text-muted-foreground">
                          {event.at}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
