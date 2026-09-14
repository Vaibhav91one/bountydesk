"use client";

import { useState } from "react";
import { ArrowSquareOut, CaretDown } from "@phosphor-icons/react/ssr";

import { AnimatedMascotSvg } from "@/components/animated-mascot-svg";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { LifecycleEventView, LifecycleStepView } from "@/lib/reports/case-view";
import type { ToolCallView } from "@/lib/reports/tool-call-view";
import { cn } from "@/lib/utils";

import { StepBadge } from "./lifecycle-step";
import { ToolCallBlocks, type ToolCallFallback } from "./tool-call-detail";

const TOOL_CALL_PREFIX = "agent.tool_call:";

/**
 * The pipeline as a list, one row per phase. A phase with events opens a sheet holding them.
 *
 * Ported from a task-rows component that carried its own token system. What is worth keeping
 * is the grammar: a status badge, a label, a count on the right. The events themselves moved
 * out of the list into a sheet: a re-checked run records thirty-plus of them, and an inline
 * drawer that tall turned the list into a wall of rows that pushed everything below it off
 * the screen.
 *
 * Inside the sheet each event is an accordion row. A hover was tried first and kept the detail
 * one interaction away, but a hover cannot be scrolled past, and on a touch device there is
 * no hover at all; expanding in place reads the same on both.
 */
export function LifecycleList({
  steps,
  details,
}: {
  steps: LifecycleStepView[];
  /**
   * Live tool-call detail, keyed by TrueForge call id, from its own query. A mirrored event
   * carries that id on its eventKey as "agent.tool_call:<id>", which is the only way back to
   * the un-redacted arguments: the event's own type holds the tool name and nothing else.
   * Empty whenever the harness is unreachable, and a row without a match renders plain.
   */
  details?: Record<string, ToolCallView>;
}) {
  const [openStep, setOpenStep] = useState<LifecycleStepView | null>(null);

  const detailFor = (eventKey: string | null) =>
    eventKey?.startsWith(TOOL_CALL_PREFIX)
      ? details?.[eventKey.slice(TOOL_CALL_PREFIX.length)]
      : undefined;

  // The always-present source: the mirrored tool name and preview, so a tool-call row expands
  // even where the live detail never arrives (the Vercel tier cannot reach the harness).
  const fallbackFor = (event: LifecycleEventView): ToolCallFallback | null =>
    event.toolName && event.argsPreview
      ? { toolName: event.toolName, argsPreview: event.argsPreview }
      : null;

  const openableStep = openStep ? steps.find((s) => s.key === openStep.key) ?? openStep : null;

  return (
    <>
      {/* h-full and justify-between: the panel is stretched to the diagram beside it, and rows
          bunched at the top under half a panel of nothing reads as a list that failed to load. */}
      <ol className="flex h-full flex-col justify-between">
        {steps.map((step, index) => {
          const hasEvents = step.events.length > 0;

          return (
            <li
              key={step.key}
              className="animate-step-in border-b border-border/50 last:border-b-0 motion-reduce:animate-none"
              style={{ animationDelay: `${index * 70}ms` }}
            >
              <button
                type="button"
                disabled={!hasEvents}
                onClick={() => setOpenStep(step)}
                className="flex w-full items-center gap-3 px-4 py-4 text-left enabled:hover:bg-muted/40 disabled:cursor-default"
              >
                <StepBadge state={step.state} index={index + 1} />

                {/* Agent Bounty doing the thing the row names. A phase nobody reached is drawn
                    faint rather than swapped for a placeholder: it is the same step, not yet. */}
                <AnimatedMascotSvg
                  state={step.mascot}
                  scope={`lifecycle-${step.key}`}
                  className={cn(
                    "size-12 shrink-0 [&>svg]:block [&>svg]:size-full",
                    step.state === "pending" && "opacity-40",
                  )}
                />

                <span className="min-w-0 flex-1 text-body font-medium text-foreground">
                  <span className="line-clamp-2">{step.label}</span>
                </span>

                <span className="shrink-0 text-meta text-muted-foreground">{step.note}</span>

                {/* An outward affordance rather than the old chevron: the row no longer
                    expands in place, it opens the sheet that holds the events. */}
                {hasEvents ? (
                  <ArrowSquareOut
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                ) : (
                  <span aria-hidden="true" className="size-3.5 shrink-0" />
                )}
              </button>
            </li>
          );
        })}
      </ol>

      {/* The step is looked back up from props on every render, so the sheet keeps receiving
          the live query's newest copy of the events while it is open. */}
      <Sheet open={openStep !== null} onOpenChange={(open) => !open && setOpenStep(null)}>
        <SheetContent
          side="right"
          className="no-scrollbar flex flex-col gap-0 overflow-y-auto sm:max-w-xl"
        >
          <SheetHeader>
            <SheetTitle className="text-body font-medium">{openableStep?.label}</SheetTitle>
            <SheetDescription>
              {openableStep?.events.length ?? 0} events recorded during this phase. Expand a
              tool call for its arguments and result.
            </SheetDescription>
          </SheetHeader>

          <div className="px-4">
            {openableStep?.events.map((event) => {
              const detail = detailFor(event.eventKey);
              const fallback = fallbackFor(event);
              return (
                <EventRow key={event.seq} event={event} detail={detail} fallback={fallback} />
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * One event as an accordion row: the type and timestamp always visible, the arguments and
 * result one click away. Events that are not tool calls (or whose mirror was lost) render as
 * the plain row they always were.
 */
function EventRow({
  event,
  detail,
  fallback,
}: {
  event: LifecycleEventView;
  detail: ToolCallView | null | undefined;
  fallback: ToolCallFallback | null;
}) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(detail || fallback);

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-4 py-3 text-left enabled:hover:bg-muted/40 disabled:cursor-default"
      >
        <span className="min-w-0 flex-1 text-meta text-muted-foreground">
          <span className="line-clamp-2">{event.type}</span>
        </span>
        <span className="shrink-0 font-mono text-meta tabular-nums text-muted-foreground">
          {event.at}
        </span>
        <CaretDown
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-300",
            open && "rotate-180",
            !expandable && "invisible",
          )}
        />
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className="overflow-hidden">
          <div className="pb-4">
            <ToolCallBlocks detail={detail} fallback={fallback} />
          </div>
        </div>
      </div>
    </div>
  );
}
