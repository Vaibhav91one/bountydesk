"use client";

import { motion, useReducedMotion } from "motion/react";

/** Only what callers need. Each maps to a motion component, which a bare string cannot. */
const ELEMENTS = { div: motion.div, li: motion.li } as const;

/**
 * Content that rises into place the first time it is scrolled to.
 *
 * For things below the fold, where the page's load sequence is no use: by the time anyone has
 * scrolled this far a load animation has long since finished, and they would arrive to find it
 * already over.
 *
 * `once`, because a row that re-animates every time it scrolls back into view is a row that
 * will not sit still.
 *
 * `render` exists so this can be the list item itself rather than a wrapper inside one. A div
 * between a ul and its li breaks the grid's own children, and the cards stop sharing a height.
 */
export function Reveal({
  delay = 0,
  render = "div",
  className,
  children,
}: {
  /** Seconds. Callers stagger a list by passing an index times a step. */
  delay?: number;
  render?: keyof typeof ELEMENTS;
  className?: string;
  children: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const Element = ELEMENTS[render];

  if (reduced) {
    const Plain = render;
    return <Plain className={className}>{children}</Plain>;
  }

  return (
    <Element
      className={className}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      // The same curve the rest of the page eases on, so this reads as one hand.
      transition={{ duration: 0.45, delay, ease: [0.23, 1, 0.32, 1] }}
    >
      {children}
    </Element>
  );
}
