"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import { useReducedMotion } from "motion/react";

/**
 * Smooth scrolling, on the pages that want it.
 *
 * Mounted on the marketing pages rather than in the root layout. The console has its own
 * scrollable panels, sheets and a sidebar, and a library that takes over the page's scroll
 * fights them; widening this later is a one-line move, and undoing it after it has broken a
 * sheet is not.
 *
 * Lenis drives the real scroll position rather than a transform, so anything reading
 * window.scrollY still works. The parallax backdrops depend on that.
 *
 * Renders nothing.
 */
export function SmoothScroll() {
  // Subscribed rather than read once, so turning the preference on tears this down on a page
  // that is already open.
  const reduced = useReducedMotion();

  useEffect(() => {
    // Asking for reduced motion and getting scroll inertia is the exact complaint the setting
    // exists to answer, so this stays off rather than running faster.
    if (reduced) return;

    const lenis = new Lenis();
    let frame = 0;

    function raf(time: number) {
      lenis.raf(time);
      frame = requestAnimationFrame(raf);
    }
    frame = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(frame);
      lenis.destroy();
    };
  }, [reduced]);

  return null;
}
