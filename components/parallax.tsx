"use client";

import { useRef } from "react";
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react";

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
 */
export function Parallax({
  from,
  to,
  className,
  children,
}: {
  /** Offset at the moment the frame enters the viewport. */
  from: string;
  /** Offset as it leaves. */
  to: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  // start end to end start: the whole time any part of the frame is on screen, rather than
  // beginning once it is already halfway up.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
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
