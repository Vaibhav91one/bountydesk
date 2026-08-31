"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

import { useMascotMarkup } from "@/components/animated-mascot-svg";

/**
 * One mascot on a card: bobbing, and out of step with its neighbours.
 *
 * Two animations run here and only one of them is CSS's to stagger. The bob is this file's,
 * and a negative delay puts each card at a different point of it. The artwork's own animation
 * is not: the exported SVG carries a choreography of dozens of elements whose delays are
 * relative to each other, every copy starts when the page loads, and a column of the same
 * state therefore performs in lockstep, which is what made four cards read as one picture
 * repeated.
 *
 * Shifting each animation's startTime moves the whole performance and leaves the choreography
 * intact, which setting animation-delay on the descendants would not: that would overwrite the
 * relative delays the artwork depends on and flatten it into a single beat.
 */
export function MascotFloat({
  state,
  scope,
  seconds,
  delay,
  y,
  tilt,
}: {
  state: string;
  scope: string;
  seconds: number;
  /** Negative, so the bob starts partway through rather than holding still until its turn. */
  delay: number;
  y: string;
  tilt: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const markup = useMascotMarkup(state, scope);
  // Subscribed rather than read once, so turning the preference on stills a board that is
  // already open and turning it off starts it again.
  const reduced = useReducedMotion();
  const staggered = useRef(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const animations = node.getAnimations({ subtree: true });

    // The artwork carries its own infinite animation inside the SVG, where no class can reach
    // it: motion-reduce stops the bob on the wrapper and leaves the drawing running. Pausing is
    // the only thing that answers the preference for the part of this that is not ours.
    if (reduced) {
      for (const animation of animations) animation.pause();
      return;
    }

    for (const animation of animations) animation.play();

    // Once. The shift is relative to the animation's own clock, so applying it a second time
    // would move the copy further out of step every time the preference is toggled.
    if (staggered.current) return;
    staggered.current = true;

    for (const animation of animations) {
      if (animation.startTime !== null) {
        animation.startTime = Number(animation.startTime) + delay * 1000;
      }
    }
  }, [delay, markup, reduced]);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className="animate-mascot-float -my-2 size-20 shrink-0 motion-reduce:animate-none [&>svg]:block [&>svg]:size-full"
      style={{
        animationDuration: `${seconds}s`,
        animationDelay: `${delay}s`,
        ["--float-y" as string]: y,
        ["--float-tilt" as string]: tilt,
      }}
      dangerouslySetInnerHTML={markup ? { __html: markup } : undefined}
    />
  );
}
