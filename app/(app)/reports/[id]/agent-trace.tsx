"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { CaretDown, Check, Sparkle } from "@phosphor-icons/react/ssr";

import { cn } from "@/lib/utils";

import { ToolCallHover, type ToolCallView } from "./tool-call-detail";

/**
 * The pixel-grid loader, ported from a loading-state component.
 *
 * Nine cells running one fade on nine delays, so a wavefront appears to travel across the
 * grid. The cycle is shorter than the sweep, which keeps two fronts in flight and stops it
 * reading as a metronome.
 */
const WAVEFRONT = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3);
  const column = i % 3;
  return (column + Math.abs(row - 1)) * 90;
});

export function LoaderGrid() {
  return (
    <span aria-hidden="true" className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
      {WAVEFRONT.map((delay, index) => (
        <span
          key={index}
          className="size-[4px] animate-grid-pulse rounded-[1px] bg-foreground opacity-15 motion-reduce:animate-none"
          style={{ animationDelay: `${delay}ms`, animationDuration: "650ms" }}
        />
      ))}
    </span>
  );
}

/** A label that shimmers while something is running. Clipped to the glyphs, not the box. */
export function ShimmerLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="animate-shimmer-text bg-clip-text text-body font-medium text-transparent motion-reduce:animate-none motion-reduce:text-muted-foreground"
      style={{
        backgroundImage:
          "linear-gradient(90deg, var(--muted-foreground) 35%, var(--foreground) 50%, var(--muted-foreground) 65%)",
        backgroundSize: "200% 100%",
      }}
    >
      {children}
    </span>
  );
}

// detail carries the live TrueForge arguments and result for a mirrored tool-call row, matched
// by id in the page. Only "agent.tool_call:<name>" rows whose detail still exists carry it; the
// rest render plain, with no hover.
export type TraceRow = { seq: number; type: string; at: string; detail?: ToolCallView };

/**
 * What the agent actually did, expandable.
 *
 * Ported from a thinking-state component, with its fake four-second sequence removed. These
 * rows are session_event rows: the run is over by the time anybody opens this, so there is
 * nothing to animate into being and no reason to pretend otherwise. The staggered entrance
 * stays, because the rows do arrive when the panel opens.
 */
export function AgentTrace({ rows }: { rows: TraceRow[] }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="-mx-1.5 flex w-fit items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/40"
      >
        {/* Blue for the agent's own marks, green for what finished, the same pair the rest
            of the console uses. Phase tokens rather than raw colours, so the dialog cannot
            drift away from the board. */}
        <Sparkle weight="fill" aria-hidden="true" className="size-4 text-phase-triaging" />
        <span className="text-body font-medium text-foreground">
          {rows.length === 0
            ? "Nothing recorded"
            : `Ran ${rows.length} ${rows.length === 1 ? "step" : "steps"}`}
        </span>
        <CaretDown
          aria-hidden="true"
          className={cn(
            "size-3.5 text-muted-foreground transition-transform duration-300",
            open && "rotate-180",
          )}
        />
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[7px] pl-4">
            <span aria-hidden="true" className="absolute top-0 left-0 h-full w-px bg-border/50" />
            <ul className="flex flex-col gap-1 py-1">
              {rows.map((row, index) => (
                <li
                  key={row.seq}
                  className="animate-step-in flex items-center gap-2 motion-reduce:animate-none"
                  style={{ animationDelay: `${index * 90}ms` }}
                >
                  <Check
                    weight="bold"
                    aria-hidden="true"
                    className="size-3 shrink-0 text-phase-delivered"
                  />
                  <ToolCallHover detail={row.detail}>
                    <span className="min-w-0 flex-1 truncate text-meta text-foreground">
                      {row.type}
                    </span>
                    <span className="shrink-0 font-mono text-meta tabular-nums text-muted-foreground">
                      {row.at}
                    </span>
                  </ToolCallHover>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Text revealed a word at a time, ported from a streaming component.
 *
 * The words are already known when this mounts; the reveal is presentation. Reduced motion
 * gets the whole string at once rather than a slow one, because the animation is the only
 * thing being skipped and the content is the point.
 */
/**
 * Whether the viewer asked for less motion.
 *
 * Read through useSyncExternalStore rather than in an effect: it is a browser value the server
 * cannot know, and setting state for it on mount is both an extra render and the thing the
 * hooks lint is right to object to.
 */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

export function StreamingText({ text, onDone }: { text: string; onDone?: () => void }) {
  const words = text.split(" ");
  const reduced = usePrefersReducedMotion();
  const [ticks, setTicks] = useState(0);
  const shown = reduced ? words.length : Math.min(ticks, words.length);

  useEffect(() => {
    if (shown >= words.length) {
      onDone?.();
      return;
    }
    const timer = setTimeout(() => setTicks((current) => current + 1), 45);
    return () => clearTimeout(timer);
  }, [shown, words.length, onDone]);

  return (
    <p className="text-body leading-relaxed text-foreground">
      {words.slice(0, shown).join(" ")}
      {shown < words.length ? (
        <span className="ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 rounded-full bg-foreground" />
      ) : null}
    </p>
  );
}
