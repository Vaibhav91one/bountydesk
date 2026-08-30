"use client";

import { useRef } from "react";
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react";

/** useScroll's own offset type, so this stays right if motion changes it. */
type ScrollOffset = NonNullable<Parameters<typeof useScroll>[0]>["offset"];

/**
 * A backdrop that drifts against the page as it scrolls.
 *
 * What makes a photograph behind an interface read as depth rather than wallpaper is that it
 * does not travel at the same speed as the thing in front of it. The frame moves with the page
 * and the picture inside it lags, which is the whole effect.
 *
 * The ref sits on the outer box and the transform on a child, deliberately. useScroll measures
 * the element it is given, so pointing it at the element being moved would feed the transform
 * back into its own input.
 *
 * Callers size the child with headroom in the markup, and `from` and `to` stay inside it. Get
 * that wrong and the drift pulls an edge of the image into the frame, which is the one way this
 * looks broken rather than absent.
 *
 * `offset` matters more than it looks. Whatever progress the element is at when the page loads
 * has to be the progress the server rendered, or the picture paints at `from` and then snaps to
 * its real position the moment this hydrates. The default suits a frame that starts below the
 * fold, which is at progress 0 on load. A frame already on screen needs one whose progress is 0
 * where it actually sits.
 */
export function Parallax({
  from,
  to,
  offset = ["start end", "end start"],
  className,
  children,
}: {
  /** Offset at progress 0. */
  from: string;
  /** Offset at progress 1. */
  to: string;
  /** Where the drift starts and ends, in useScroll's terms. */
  offset?: ScrollOffset;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  const { scrollYProgress } = useScroll({ target: ref, offset });
  const y = useTransform(scrollYProgress, [0, 1], [from, to]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="absolute inset-0 overflow-hidden"
    >
      <motion.div className={className} style={reduced ? undefined : { y }}>
        {children}
      </motion.div>
    </div>
  );
}
