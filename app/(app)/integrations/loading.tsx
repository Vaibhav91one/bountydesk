import { Skeleton } from "@/components/ui/skeleton";

/**
 * The integrations list is dynamic (it reads the live GitHub connection state), so a navigation
 * to it waits on that read. Without a loading boundary at this segment the router keeps the
 * previous page on screen until the read finishes, which reads as a click that did nothing. This
 * gives the segment its own instant fallback: the shell shows at once, the rows fill in after.
 */
export default function Loading() {
  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-col gap-4 border-b border-border/50 px-8 py-7">
        <Skeleton className="h-7 w-56" />
        <div className="flex gap-3">
          <Skeleton className="h-11 flex-1" />
          <Skeleton className="h-11 w-52" />
        </div>
      </header>
      <div className="flex flex-col gap-2.5 p-8">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-4 rounded-xl border border-border/50 bg-card px-4 py-3.5">
            <Skeleton className="size-11 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3.5 w-64" />
            </div>
            <Skeleton className="h-8 w-16" />
          </div>
        ))}
      </div>
    </main>
  );
}
