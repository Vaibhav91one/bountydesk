"use client";

import { X } from "@phosphor-icons/react/ssr";

/** Said once for a screen reader, and repeated across the strip for everyone else. */
const CREDIT =
  "Built for the WeMakeDevs × TrueFoundry × Qodo Agent Harness Hackathon";

/** How many times the line appears in one copy of the track. Enough to fill a wide screen. */
const PER_COPY = 3;

/**
 * The strip above the header.
 *
 * Two identical copies of the track travelling exactly half its width, which is what makes the
 * loop seamless without measuring anything: the moment copy one has left, copy two is where it
 * started. Percentages rather than pixels, so the line's length can change with the text and
 * nothing has to be recalculated.
 *
 * Agent Bounty rides between cycles as a plain <img>. Everywhere the artwork has to change with
 * a report's state it goes through components/animated-mascot-svg.tsx, which injects the markup
 * so the keyframes inside it run; on a decorative strip that never changes, the file is fetched
 * once and shared by every copy instead.
 *
 * The whole marquee is hidden from assistive technology and the sentence is offered once in
 * text, because a screen reader should hear this a single time rather than six.
 */
export function SiteBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="relative overflow-hidden bg-emerald-500 text-emerald-950">
      <p className="sr-only">{CREDIT}</p>

      <div
        aria-hidden="true"
        className="animate-mascot-marquee-x flex w-max motion-reduce:animate-none"
        style={{
          animationDuration: "48s",
          ["--marquee-travel" as string]: "-50%",
        }}
      >
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0">
            {Array.from({ length: PER_COPY }, (_, i) => (
              <span
                key={i}
                className="flex shrink-0 items-center gap-4 px-4 py-1.5 text-meta font-medium whitespace-nowrap"
              >
                {CREDIT}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/mascot/idle.svg"
                  alt=""
                  width={28}
                  height={28}
                  className="size-7 shrink-0"
                />
              </span>
            ))}
          </div>
        ))}
      </div>

      {/* Carries the strip's own colour so the marquee passes behind it rather than under it,
          and sits above the track so a line of text never lands on the cross. */}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss the banner"
        className="absolute inset-y-0 right-0 z-10 flex items-center bg-emerald-500 pr-4 pl-6 text-emerald-950/70 transition-colors hover:text-emerald-950"
      >
        <X aria-hidden="true" weight="bold" className="size-3.5" />
      </button>
    </div>
  );
}
