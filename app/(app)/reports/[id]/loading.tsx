import { Skeleton } from "@/components/ui/skeleton";

/** The case file's shape while it loads: a header, two columns, then the stacked panels. */
export default function Loading() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="flex flex-col gap-4 border-b border-border/50 px-8 py-7">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-7 w-96" />
        <Skeleton className="h-4 w-72" />
      </div>

      <div className="flex flex-col gap-4 p-8">
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-56 lg:col-span-2" />
          <Skeleton className="h-56" />
        </div>
        <Skeleton className="h-32" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
        <Skeleton className="h-40" />
      </div>
    </main>
  );
}
