"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { MASCOT_STATES, type MascotKey } from "@/lib/mascot/catalog";
import { cn } from "@/lib/utils";

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
    .then((markup) => markup.replace(/^<svg width="\d+" height="\d+"/, "<svg"));

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
        if (!cancelled && key !== "idle") {
          void loadMascot("idle").then((next) => {
            if (!cancelled) setLoaded({ key: "idle", markup: next });
          });
        }
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
