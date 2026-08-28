import { Skeleton } from "@/components/ui/skeleton";

/**
 * The console's loading state.
 *
 * Skeletons rather than a spinner: this renders inside the shell, so the sidebar and header
 * are already there and the shapes below are the ones about to be filled in. The space screen
 * is the site preloader and belongs to the first load, not to every navigation.
 */
export default function Loading() {
  return (
    <main className="flex flex-1 flex-col gap-8 p-8">
      <div className="flex items-center gap-4">
        <Skeleton className="size-24 shrink-0 rounded-xl" />
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-full max-w-3xl" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((card) => (
          <section key={card} className="flex flex-col gap-4 rounded-xl border border-border/50 bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="size-10 rounded-lg" />
              <Skeleton className="h-6 w-24" />
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
            <Skeleton className="mt-2 h-10 w-40" />
          </section>
        ))}
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-border/50 bg-card p-5">
        <Skeleton className="h-3 w-44" />
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-4 w-full max-w-2xl" />
        ))}
      </div>
    </main>
  );
}
