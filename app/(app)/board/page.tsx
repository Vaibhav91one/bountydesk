import { Badge } from "@/components/ui/badge";
import { requireReviewer } from "@/lib/auth/dal";
import { listQueue } from "@/lib/reports/queue";
import { queueColumnViews } from "@/lib/reports/queue-view";

import { QueueLive } from "./queue-live";

export const metadata = { title: "Review queue · BountyDesk" };

export default async function BoardPage() {
  await requireReviewer();
  const columns = queueColumnViews(await listQueue());
  const total = columns.reduce((sum, column) => sum + column.total, 0);

  return (
    <main className="flex flex-1 flex-col">
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
        <QueueLive initial={columns} />
      )}
    </main>
  );
}
