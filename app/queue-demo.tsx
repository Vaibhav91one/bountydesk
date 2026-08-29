"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

/**
 * A card changing phase, on a loop.
 *
 * The board is a server-rendered snapshot and live updates are not built, so a real phase
 * change cannot animate there yet. This is the landing page's illustration of one, in a panel
 * already marked Example, rather than machinery in the app that nothing could trigger.
 *
 * Nothing is ever positioned over anything. The card leaves by fading and sinking, then its
 * row collapses; the destination row opens first and the card rises into space that already
 * exists. That ordering is the whole reason it cannot overlap a sibling, and it is the
 * disclosure idiom this codebase already uses in four other places, applied to a row that is
 * arriving rather than one being revealed.
 */

/** Long enough to read the card in each column, short enough to see twice while scrolling. */
const DWELL = 2600;
const MOVE = 340;

type Phase = "settled" | "leaving" | "arriving";

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
 * Where the travelling card currently is, and how it is moving.
 *
 * `column` is which list holds it; `phase` drives the two transitions. A reduced-motion viewer
 * gets the column change with neither, which is the whole point: the information still moves,
 * the movement just is not animated.
 */
export function useTravellingCard() {
  const still = usePrefersReducedMotion();
  const [column, setColumn] = useState(0);
  const [phase, setPhase] = useState<Phase>("settled");

  useEffect(() => {
    if (still) {
      const timer = window.setInterval(
        () => setColumn((c) => (c + 1) % 2),
        DWELL * 2,
      );
      return () => window.clearInterval(timer);
    }

    let timers: number[] = [];
    const run = () => {
      setPhase("leaving");
      timers.push(
        window.setTimeout(() => {
          setColumn((c) => (c + 1) % 2);
          setPhase("arriving");
          timers.push(window.setTimeout(() => setPhase("settled"), MOVE));
        }, MOVE),
      );
    };

    const loop = window.setInterval(run, DWELL + MOVE * 2);
    return () => {
      window.clearInterval(loop);
      timers.forEach(window.clearTimeout);
      timers = [];
    };
  }, [still]);

  return { column, phase, still };
}

/**
 * The row the travelling card lives in.
 *
 * A grid whose single row animates between 1fr and 0fr, so the column's own height carries the
 * movement and the cards below it slide rather than being covered.
 */
export function TravellingRow({
  present,
  phase,
  still,
  children,
}: {
  present: boolean;
  phase: Phase;
  still: boolean;
  children: React.ReactNode;
}) {
  const open = present && phase !== "leaving";

  return (
    <div
      aria-hidden={!present}
      className={cn(
        "grid",
        !still &&
          "transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]",
      )}
      style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
    >
      <div className="overflow-hidden">
        <div
          className={cn(
            "pb-3",
            !still &&
              "transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]",
            !still && phase === "leaving" && "translate-y-2 opacity-0",
            !still && phase === "arriving" && "-translate-y-2 opacity-0",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Clicks land and nothing happens.
 *
 * These are the console's real components, which means their titles and rows navigate, and a
 * visitor halfway down the landing page does not want to be dropped into /login by a stray
 * click on an illustration. Blocked in the capture phase, before the row's own handler and
 * before Link's, which checks defaultPrevented and stands down. The search field and the
 * filter chips keep working: this only catches links and rows.
 */
export function Inert({ children }: { children: React.ReactNode }) {
  return (
    <div
      // display:contents, so this wrapper takes part in event propagation but not in layout:
      // the panel inside stays a direct child of the box and can still fill its height.
      className="contents"
      onClickCapture={(event) => {
        const target = event.target as HTMLElement;
        // A row is a button with its own onClick, so preventDefault alone would not stop it.
        // The chips and the search field are neither, and go through untouched.
        if (target.closest("[data-row]")) event.stopPropagation();
        if (target.closest("a[href], [data-row]")) event.preventDefault();
      }}
    >
      {children}
    </div>
  );
}
