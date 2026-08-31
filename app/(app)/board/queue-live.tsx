"use client";

import { useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { MagnifyingGlass } from "@phosphor-icons/react/ssr";

import { Column, MASCOT_ON_CARD } from "@/components/queue-board";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { mascotKeyForState } from "@/lib/mascot/catalog";
import { searchQueue, type QueueColumnView } from "@/lib/reports/queue-view";
import { fetchLive, listRefetchInterval, queueQueryKey } from "@/lib/reports/status-query";

/**
 * The board, keeping itself current.
 *
 * It used to do this with router.refresh() on a timer, which re-ran the whole server component
 * and shipped a fresh copy of the markup for five columns to move one card between two of them.
 * A card's state is the only thing that changes, so that is the only thing fetched.
 */
export function QueueLive({ initial }: { initial: QueueColumnView[] }) {
  const [query, setQuery] = useState("");

  const { data: live = initial } = useQuery({
    queryKey: queueQueryKey(),
    queryFn: () => fetchLive<QueueColumnView[]>("/api/queue"),
    initialData: initial,
    refetchInterval: (query) =>
      listRefetchInterval((query.state.data ?? initial).flatMap((column) => column.cards)),
  });

  const searching = query.trim().length > 0;
  const columns = useMemo(() => searchQueue(live, query), [live, query]);

  const total = columns.reduce((sum, column) => sum + column.total, 0);
  // An empty board and a search that found nothing read the same in the columns and mean
  // opposite things, so they get different copy below.
  const empty = live.every((column) => column.total === 0);

  // Numbered across the board rather than within a column, so the mascots' drifts stay spread
  // out even when one column holds every mascot on screen.
  const drift = new Map<string, number>();
  const mascots = new Map<string, ReturnType<typeof mascotKeyForState>>();
  for (const column of columns) {
    for (const card of column.cards) {
      if (!MASCOT_ON_CARD.has(card.state)) continue;
      mascots.set(card.state, mascotKeyForState(card.state));
      drift.set(card.id, drift.size);
    }
  }

  return (
    // Bounded to the viewport, less the shell's 3.5rem header, because each column scrolls on
    // its own below. A board that let the document scroll instead would carry the header and
    // the four columns a reviewer is not reading off the top of the screen to reach the fifth.
    <main className="flex h-[calc(100svh-3.5rem)] flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-border/50 px-8 py-7">
        <h1 className="text-title text-foreground">Review queue</h1>
        <Badge variant="outline">{total}</Badge>

        <div className="relative ml-auto w-full max-w-xs">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by title, issue or target"
            aria-label="Search the review queue"
            className="h-10 border-border/50 pl-9 text-body"
          />
        </div>
      </header>

      {empty ? (
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
        // The strip scrolls sideways, not the page: six columns do not fit the content area at
        // 1440, and a board that pushes the whole document sideways is worse than one that does
        // not. Down is each column's own business, which is what min-h-0 and h-full leave room
        // for: without them the grid grows to its tallest column and nothing has a height to
        // scroll within.
        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-3 py-8">
          {/* A grid rather than a flex row, so every column is the same height and the rules
              between them run the full board instead of stopping at the tallest stack of
              cards. divide-x draws them, which means no separator element to keep in step
              with the column count. */}
          <div className="grid h-full min-w-max auto-cols-[300px] grid-flow-col divide-x divide-border/50">
            {columns.map((column) => (
              <Column
                key={column.key}
                column={column}
                mascots={mascots}
                drift={drift}
                emptyLabel={searching ? "No matches" : undefined}
              />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
