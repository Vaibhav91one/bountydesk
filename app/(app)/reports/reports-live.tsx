"use client";

import { fetchLive, listRefetchInterval, reportsIndexQueryKey } from "@/lib/reports/status-query";
import { useQuery } from "@tanstack/react-query";

import { ReportsTable, type ReportRow } from "./reports-table";

/**
 * The reports index, keeping itself current.
 *
 * The query lives here rather than in ReportsTable because that component is also rendered on
 * the public landing page, which has no QueryClientProvider above it; a hook in there fails the
 * build rather than the request, which is at least honest about when it would have broken.
 */
export function ReportsLive({ initial }: { initial: ReportRow[] }) {
  const { data: rows = initial } = useQuery({
    queryKey: reportsIndexQueryKey(),
    queryFn: () => fetchLive<ReportRow[]>("/api/reports"),
    initialData: initial,
    refetchInterval: (query) =>
      listRefetchInterval(query.state.data ?? initial),
  });

  return <ReportsTable rows={rows} />;
}
