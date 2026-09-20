"use client";

import type { CSSProperties } from "react";

import { useMascotMarkup } from "@/components/animated-mascot-svg";
import type { MascotKey } from "@/lib/mascot/catalog";
import { cn } from "@/lib/utils";

/**
 * A static mascot rendered at icon size. Unlike AnimatedMascotSvg this does not
 * run the artwork's internal animations: it is a still, properly-sized icon for
 * buttons and inline use. The underlying SVG is 256x256, so sizing it with a
 * size-* class (e.g. size-4 = 1rem) scales it cleanly to any icon size.
 */
export function MascotIcon({
  state,
  scope = "mascot-icon",
  className,
  style,
}: {
  state: string;
  scope?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const markup = useMascotMarkup(state, scope);

  return (
    <span
      aria-hidden="true"
      className={cn("block shrink-0 [&>svg]:block [&>svg]:size-full", className)}
      style={style}
      dangerouslySetInnerHTML={markup ? { __html: markup } : undefined}
    />
  );
}
