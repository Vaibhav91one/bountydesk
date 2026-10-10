import { json, mobileAuth } from "@/lib/mobile/auth";
import { readHomeSummary } from "@/lib/home/summary";
import { listQueue } from "@/lib/reports/queue";

export const runtime = "nodejs";

/** The home counts: `needsYou` is the awaiting count the web card shows, `phases` the board totals. */
export async function GET(): Promise<Response> {
  const gate = await mobileAuth();
  if (!gate.ok) return gate.response;

  const [summary, columns] = await Promise.all([readHomeSummary(), listQueue()]);
  return json({
    ...summary,
    needsYou: summary.awaiting,
    phases: columns.map((column) => ({ key: column.key, label: column.label, total: column.total })),
  });
}
