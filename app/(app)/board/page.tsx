import { Badge } from "@/components/ui/badge";
import { AutoRefresh } from "@/components/auto-refresh";
import { requireReviewer } from "@/lib/auth/dal";
import { Column, MASCOT_ON_CARD } from "@/components/queue-board";
import { listQueue } from "@/lib/reports/queue";
import { MASCOT_FOR_STATE } from "@/lib/mascot/catalog";

export const metadata = { title: "Review queue · BountyDesk" };

export default async function BoardPage() {
  await requireReviewer();
  const columns = await listQueue();
  const total = columns.reduce((sum, column) => sum + column.total, 0);

  const present = new Set(columns.flatMap((c) => c.cards.map((card) => card.state)));
  const mascots = new Map(
    [...present]
      .filter((state) => MASCOT_ON_CARD.has(state))
      .map((state) => [state, MASCOT_FOR_STATE[state]] as const),
  );

  // Numbered across the board rather than within a column, so the drifts stay spread out even
  // when one column holds every mascot on screen.
  const drift = new Map<string, number>();
  for (const column of columns) {
    for (const card of column.cards) {
      if (mascots.has(card.state)) drift.set(card.id, drift.size);
    }
  }

  return (
    <main className="flex flex-1 flex-col">
      <AutoRefresh />
      <header className="flex flex-wrap items-center gap-3 border-b border-border/50 px-8 py-7">
        <h1 className="text-title text-foreground">Review queue</h1>
        <Badge variant="outline">{total}</Badge>
      </header>

      {total === 0 ? (
        <div className="p-8">
          <div className="flex flex-col items-start gap-2 rounded-xl border border-border/50 bg-card p-8">
            <h2 className="text-heading text-foreground">No reports yet</h2>
            <p className="max-w-2xl text-body text-muted-foreground">
              Reports arrive from a connected GitHub repository. Once one is bound to a
              reproduction target, issues opened there land here.
            </p>
          </div>
        </div>
      ) : (
        // The strip scrolls, not the page: six columns do not fit the content area at 1440,
        // and a board that pushes the whole document sideways is worse than one that does not.
        <div className="flex-1 overflow-x-auto px-3 py-8">
          {/* A grid rather than a flex row, so every column is the same height and the rules
              between them run the full board instead of stopping at the tallest stack of
              cards. divide-x draws them, which means no separator element to keep in step
              with the column count. */}
          <div className="grid min-h-full min-w-max auto-cols-[300px] grid-flow-col divide-x divide-border/50">
            {columns.map((column) => (
              <Column key={column.key} column={column} mascots={mascots} drift={drift} />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
