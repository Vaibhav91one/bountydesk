import { type CSSProperties } from "react";

import { AnimatedMascotSvg } from "@/components/animated-mascot-svg";
import type { MascotKey } from "@/lib/mascot/catalog";
import { cn } from "@/lib/utils";

/** Seconds each mascot takes to travel one slot. The whole loop is this times the count. */
const SECONDS_PER_STATE = 2.6;

/**
 * Agent Bounty's states drifting upward inside the headline.
 *
 * No state, no timer, no client bundle: a marquee is one CSS translation, and the list is
 * rendered twice so the second copy is exactly where the first was when the loop restarts.
 *
 * The duplicate is re-scoped. Every id, reference and keyframe name the splitter wrote is
 * prefixed with the state key, so swapping that prefix renames the whole copy in one pass.
 * Without it the two copies would share ids, and cowboy's hat pattern would resolve to
 * whichever copy the browser found first.
 */
export function MascotMarquee({
  states,
  size = 104,
  direction = "vertical",
  className,
}: {
  states: MascotKey[];
  size?: number;
  direction?: "vertical" | "horizontal";
  className?: string;
}) {
  const sideways = direction === "horizontal";
  return (
    // Spans, not divs: this lives inside a paragraph. aria-hidden because the headline already
    // says what he is, and fourteen state names read mid-sentence would only get in the way.
    <span
      aria-hidden="true"
      className={cn(
        "relative block overflow-hidden",
        sideways
          ? "[mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]"
          : // Inline in a paragraph, so it needs the optical nudge and negative margins that
            // keep a 104px box from opening up the line it sits in.
            "-top-[6px] -mx-1 -my-4 inline-block align-middle [mask-image:linear-gradient(to_bottom,transparent,black_30%,black_70%,transparent)]",
        className,
      )}
      style={sideways ? { height: size } : { width: size, height: size }}
    >
      <span
        className={cn(
          "flex motion-reduce:animate-none",
          sideways ? "animate-mascot-marquee-x flex-row" : "animate-mascot-marquee flex-col",
        )}
        style={{
          animationDuration: `${states.length * SECONDS_PER_STATE}s`,
          // How far to travel before the second copy sits where the first started.
          ["--marquee-travel" as string]: `-${states.length * size}px`,
        }}
      >
        {[...states, ...states].map((state, index) => (
          <AnimatedMascotSvg
            key={`${state}-${index}`}
            state={state}
            scope={`marquee-${index}`}
            className="shrink-0"
            style={{ width: size, height: size } as CSSProperties}
          />
        ))}
      </span>
    </span>
  );
}
