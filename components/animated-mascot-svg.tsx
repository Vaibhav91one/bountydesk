"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { MASCOT_STATES, type MascotKey } from "@/lib/mascot/catalog";
import { cn } from "@/lib/utils";

/**
 * One request per mascot per page, shared by every card showing that state.
 *
 * Only a request that is in flight or that succeeded stays here. A rejected one is evicted, so a
 * dropped connection costs the next render a retry rather than leaving that mascot blank for as
 * long as the tab is open.
 */
const cache = new Map<string, Promise<string>>();

function safeState(state: string): MascotKey {
  return (MASCOT_STATES as readonly string[]).includes(state) ? (state as MascotKey) : "idle";
}

function safeScope(scope: string): string {
  return scope.replace(/[^A-Za-z0-9_-]/g, "_");
}

async function loadMascot(state: MascotKey): Promise<string> {
  const cached = cache.get(state);
  if (cached) return cached;

  const pending = fetch(`/mascot/${state}.svg`)
    .then((response) => {
      if (!response.ok) throw new Error(`Could not load mascot ${state}`);
      return response.text();
    })
    .then((markup) => markup.replace(/^<svg width="\d+" height="\d+"/, "<svg"))
    .catch((error: unknown) => {
      // Evicted before the rejection reaches the caller, so the entry never outlives the failure.
      if (cache.get(state) === pending) cache.delete(state);
      throw error;
    });

  cache.set(state, pending);
  return pending;
}

export function useMascotMarkup(state: string, scope: string) {
  const key = safeState(state);
  const prefix = safeScope(scope);
  const [loaded, setLoaded] = useState<{ key: MascotKey; markup: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadMascot(key)
      .then((next) => {
        if (!cancelled) setLoaded({ key, markup: next });
      })
      .catch(() => {
        if (cancelled || key === "idle") return;
        // The fallback can fail too (the same dropped connection), and an unhandled rejection
        // in a render effect is a console error for a mascot nobody can see anyway.
        void loadMascot("idle")
          .then((next) => {
            if (!cancelled) setLoaded({ key: "idle", markup: next });
          })
          .catch(() => undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [key]);

  return useMemo(
    () => loaded?.markup.replaceAll(`${loaded.key}__`, `${loaded.key}__${prefix}__`) ?? null,
    [loaded, prefix],
  );
}

export function AnimatedMascotSvg({
  state,
  scope,
  className,
  style,
}: {
  state: string;
  scope: string;
  className?: string;
  style?: CSSProperties;
}) {
  const markup = useMascotMarkup(state, scope);

  return (
    <span
      aria-hidden="true"
      className={cn("block [&>svg]:block [&>svg]:size-full", className)}
      style={style}
      dangerouslySetInnerHTML={markup ? { __html: markup } : undefined}
    />
  );
}
