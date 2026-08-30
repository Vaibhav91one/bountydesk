import { AutoRefresh } from "@/components/auto-refresh";
import { requireReviewer } from "@/lib/auth/dal";
import { listAllReports, phaseOf, INDEX_LIMIT } from "@/lib/reports/queue";

import { ReportsTable } from "./reports-table";

export const metadata = { title: "Reports · BountyDesk" };

/**
 * Every report, closed ones included.
 *
 * The board is the working surface and hides terminal work on purpose, which left a delivered
 * report reachable only by its URL. This is the list that hides nothing.
 */
export default async function ReportsPage() {
  await requireReviewer();
  const rows = await listAllReports();

  return (
    <main className="flex flex-1 flex-col">
      <AutoRefresh />
      <header className="flex flex-wrap items-baseline justify-between gap-4 border-b border-border/50 px-8 py-7">
        <div className="flex flex-col gap-1">
          <h1 className="text-title text-foreground">Reports</h1>
          <p className="text-meta text-muted-foreground">
            Everything that has arrived, whatever state it ended in.
          </p>
        </div>
        {rows.length === INDEX_LIMIT ? (
          <span className="text-meta text-muted-foreground">
            Showing the {INDEX_LIMIT} most recently changed.
          </span>
        ) : null}
      </header>

      <ReportsTable
        rows={rows.map((row) => ({
          ...row,
          phase: phaseOf(row.state),
          updatedAt: row.updatedAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        }))}
      />
    </main>
  );
}
