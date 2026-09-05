import { requireReviewer } from "@/lib/auth/dal";
import { listQueue } from "@/lib/reports/queue";
import { queueColumnViews } from "@/lib/reports/queue-view";

import { QueueLive } from "./queue-live";

export const metadata = { title: "Review queue · BountyDesk" };

export default async function BoardPage() {
  await requireReviewer();
  const columns = queueColumnViews(await listQueue());

  return <QueueLive initial={columns} />;
}
