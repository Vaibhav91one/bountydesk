"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { cn } from "@/lib/utils";

const SEEN_KEY = "bountydesk:preloader";

/** sessionStorage throws outright in some privacy modes, and a splash screen is not worth a crash. */
function seenThisSession(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(): void {
  try {
    sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Nothing to do. The splash shows again next load, which is the harmless failure.
  }
}

/**
 * The splash screen, and the thing that waits for the site to actually be ready.
 *
 * It holds until the document has finished loading and the fonts have resolved, then for
 * whatever is left of the minimum, so the screen is legible rather than a flash. The overlay
 * is server-rendered, so it covers the page from the first paint, before this component's
 * JavaScript has run at all.
 *
 * Once per browser session. A three second wait on every reload is the kind of thing that
 * gets deleted a week later.
 */
export function SitePreloader({
  children,
  minimumMs = 3000,
}: {
  children: ReactNode;
  minimumMs?: number;
}) {
  const [phase, setPhase] = useState<"showing" | "fading" | "gone">("showing");
  // Read after hydration rather than during render: the server has no sessionStorage, and
  // this is the shape React provides for a value only the browser knows. It never changes
  // while a page is open, so the subscribe callback has nothing to do.
  const seen = useSyncExternalStore(
    () => () => {},
    seenThisSession,
    () => false,
  );

  useEffect(() => {
    if (seen) return;

    const startedAt = performance.now();
    let live = true;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const loaded = new Promise<void>((resolve) => {
      if (document.readyState === "complete") return resolve();
      window.addEventListener("load", () => resolve(), { once: true });
    });

    void Promise.all([loaded, document.fonts.ready]).then(() => {
      if (!live) return;
      const remaining = Math.max(0, minimumMs - (performance.now() - startedAt));
      timers.push(
        setTimeout(() => {
          if (!live) return;
          remember();
          setPhase("fading");
          timers.push(setTimeout(() => live && setPhase("gone"), 500));
        }, remaining),
      );
    });

    return () => {
      live = false;
      timers.forEach(clearTimeout);
    };
  }, [minimumMs, seen]);

  if (seen || phase === "gone") return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[60] transition-opacity duration-500",
        phase === "fading" && "pointer-events-none opacity-0",
      )}
    >
      {children}
    </div>
  );
}
