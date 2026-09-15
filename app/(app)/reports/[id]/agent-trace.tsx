"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

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

/**
 * Text revealed a word at a time, ported from a streaming component.
 *
 * The words are already known when this mounts; the reveal is presentation. Reduced motion
 * gets the whole string at once rather than a slow one, because the animation is the only
 * thing being skipped and the content is the point.
 */
export function StreamingText({ text, onDone }: { text: string; onDone?: () => void }) {
  const words = text.split(" ");
  const reduced = usePrefersReducedMotion();
  const [ticks, setTicks] = useState(0);
  const doneRef = useRef(false);
  const shown = reduced ? words.length : Math.min(ticks, words.length);

  useEffect(() => {
    if (shown >= words.length) {
      if (!doneRef.current) {
        doneRef.current = true;
        onDone?.();
      }
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
