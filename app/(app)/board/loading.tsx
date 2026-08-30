import { Skeleton } from "@/components/ui/skeleton";

import { COLUMNS } from "@/lib/reports/queue";

/**
 * The board's own loading state.
 *
 * The columns are known before any query runs, so the skeleton is the real six with their
 * counts pending, not a generic block. The shapes that appear are the shapes that stay.
 */
export default function Loading() {
  return (
    <main className="flex flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border/50 px-8 py-7">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-6 w-10" />
      </header>

      <div className="flex-1 overflow-x-hidden p-8">
        <div className="flex min-w-max gap-4">
          {COLUMNS.map((column, index) => (
            <section key={column.key} className="flex w-[280px] shrink-0 flex-col gap-3">
              <div className="flex items-center gap-2.5">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-6 w-8" />
              </div>
              {/* Uneven by column, because a board never is. */}
              {Array.from({ length: index % 2 === 0 ? 2 : 1 }).map((_, card) => (
                <div
                  key={card}
                  className="flex flex-col gap-3 rounded-xl border border-border/50 bg-card p-4"
                >
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-3 w-3/5" />
                  <Skeleton className="h-3 w-2/5" />
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
