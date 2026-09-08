"use client";

import { useQuery } from "@tanstack/react-query";

import { fetchLive } from "@/lib/reports/status-query";

import { ConnectionTabs, type RepositoryRow } from "./connection-tabs";

/** Onboarding states that are still moving, so the panel is worth polling faster. */
const IN_FLIGHT = new Set(["PENDING_PLAN", "PENDING_BUILD", "PENDING_MANIFEST"]);
const FAST_MS = 4_000;
const AMBIENT_MS = 15_000;

/**
 * The connections table, keeping itself current, the same way the board does: a client component over
 * the server-rendered rows that refetches the read model rather than re-running the whole server
 * component. It polls faster while any repo is mid-onboarding so progress advances on its own, and
 * settles to an ambient interval otherwise.
 */
export function ConnectionsLive({ initial, installUrl }: { initial: RepositoryRow[]; installUrl: string }) {
  const { data: rows = initial } = useQuery({
    queryKey: ["connections"],
    queryFn: () => fetchLive<RepositoryRow[]>("/api/connections"),
    initialData: initial,
    refetchInterval: (query) => {
      const data = query.state.data ?? initial;
      const moving = data.some((repo) => repo.onboardingProgress && IN_FLIGHT.has(repo.onboardingProgress.state));
      return moving ? FAST_MS : AMBIENT_MS;
    },
  });

  return <ConnectionTabs repositories={rows} installUrl={installUrl} />;
}
