import * as React from "react";

const MOBILE_BREAKPOINT = 768;
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(onChange: () => void) {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Whether the viewport is phone sized.
 *
 * matchMedia is an external store, so it is read through useSyncExternalStore rather than
 * copied into state from an effect. The copy is what makes the first paint disagree with the
 * media query, and it is what the lint rule is objecting to. The server has no viewport, so it
 * reports false and hydration settles it.
 */
export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
