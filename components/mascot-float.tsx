"use client";

import { useEffect, useRef } from "react";

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
  markup,
  seconds,
  delay,
  y,
  tilt,
}: {
  markup: string;
  seconds: number;
  /** Negative, so the bob starts partway through rather than holding still until its turn. */
  delay: number;
  y: string;
  tilt: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // The bob already respects this through motion-reduce; the artwork's own animation has no
    // such class, so leaving it alone here is the only thing that keeps it still.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    for (const animation of node.getAnimations({ subtree: true })) {
      if (animation.startTime !== null) {
        animation.startTime = Number(animation.startTime) + delay * 1000;
      }
    }
  }, [delay]);

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
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
