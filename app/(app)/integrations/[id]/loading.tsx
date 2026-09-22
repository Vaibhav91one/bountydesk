import { Skeleton } from "@/components/ui/skeleton";

/**
 * An integration page reads live state on each request (GitHub's connections, the reviewer list),
 * so opening one waits on that read. This segment had no loading boundary, so the router held the
 * list page on screen until the read returned, which felt like the click did nothing. The fallback
 * here makes the open instant: header first, panels after.
 */
export default function Loading() {
  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-col gap-5 border-b border-border/50 px-8 py-7">
        <Skeleton className="h-3.5 w-40" />
        <div className="flex items-center gap-3">
          <Skeleton className="size-11 shrink-0 rounded-full" />
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-6 w-24" />
        </div>
        <Skeleton className="h-4 w-full max-w-3xl" />
      </header>

      <div className="grid gap-8 p-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full max-w-2xl" />
          <Skeleton className="h-4 w-4/5 max-w-2xl" />
        </div>
        <aside className="flex flex-col gap-3">
          <Skeleton className="h-5 w-24" />
          <div className="flex flex-col gap-3 rounded-xl border border-border/50 bg-card p-4">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-4 w-full" />
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
