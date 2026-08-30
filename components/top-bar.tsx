"use client";

import { useEffect, useState } from "react";

import { SiteBanner } from "@/components/site-banner";
import { cn } from "@/lib/utils";

/**
 * How far the page has to travel one way before the banner reacts.
 *
 * Distance in one direction rather than the size of a single scroll event. Smooth scrolling
 * eases past its target and settles back, so one flick arrives as a long move down followed by
 * a short correction up; measured per event that correction reads as a change of direction and
 * the banner returns in the middle of the gesture it was leaving on.
 */
const TRAVEL = 48;

/** Stay put near the top, where a short bounce would otherwise read as a scroll down. */
const SETTLE = 80;

/**
 * The banner and the header, travelling together.
 *
 * One sticky box for both. Two stacked sticky elements each asking for top-0 land on top of
 * each other, so the box sticks and its contents sit inside it.
 *
 * The banner gets out of the way going down and comes back coming up, which is the behaviour
 * of something worth saying once rather than something worth keeping. It both slides and
 * closes its row: the transform is what the eye follows, and the row collapsing is what lets
 * the header take the space rather than leaving a gap where the banner used to be. That pair
 * is the disclosure idiom this codebase uses in four other places.
 *
 * Dismissing is for the session only. Nothing is stored, so a reload brings it back, which is
 * the honest behaviour for a credit rather than a cookie notice.
 */
export function TopBar({ children }: { children: React.ReactNode }) {
  const [dismissed, setDismissed] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let last = window.scrollY;
    let travelled = 0;

    function onScroll() {
      const y = window.scrollY;
      const step = y - last;
      last = y;

      // A turn resets the count, so the distance is always measured from the last change of
      // direction rather than from wherever the page happened to start.
      if (step > 0 !== travelled > 0) travelled = 0;
      travelled += step;

      if (y <= SETTLE) setHidden(false);
      else if (travelled > TRAVEL) setHidden(true);
      else if (travelled < -TRAVEL) setHidden(false);
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const away = hidden || dismissed;

  return (
    <div className="sticky top-0 z-50">
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
        style={{ gridTemplateRows: away ? "0fr" : "1fr" }}
      >
        <div className="overflow-hidden">
          <div
            // inert rather than hidden: it is still in the layout while the row closes, and a
            // cross nobody can see should not be reachable by tab in the meantime.
            inert={away ? true : undefined}
            className={cn(
              "transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
              away && "-translate-y-full",
            )}
          >
            {/* Stays mounted once dismissed. Unmounting it on the click removed the element
                mid-transition, so it vanished instead of leaving. */}
            <SiteBanner onDismiss={() => setDismissed(true)} />
          </div>
        </div>
      </div>

      {children}
    </div>
  );
}
