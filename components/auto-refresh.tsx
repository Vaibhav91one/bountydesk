"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps a server-rendered list current without a manual reload.
 *
 * There is no SSE stream for report state in this codebase, and building one for two read-only
 * dashboards would be more than they need. router.refresh() re-runs the server component and
 * swaps in the new markup while leaving client state (an open filter, a scroll position) in
 * place, so a poll on an interval is enough here. It renders nothing.
 *
 * The tick is skipped while the tab is hidden: a backgrounded queue does not need refetching,
 * and it saves the database a query per idle tab.
 */
export function AutoRefresh({ intervalMs = 4500 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) router.refresh();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
