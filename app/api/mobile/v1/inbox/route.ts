import { json, mobileAuth } from "@/lib/mobile/auth";
import { paginate, parsePage, type InboxCard } from "@/lib/mobile/views";
import { listAllReports } from "@/lib/reports/queue";

export const runtime = "nodejs";

/**
 * The inbox for M23: "needs you" (reports awaiting a verdict decision) and "earlier" (delivered,
 * denied, expired, etc.), newest first. Each row is the same IndexRow the reports list builds, so
 * the card text cannot disagree with the index.
 */
export async function GET(request: Request): Promise<Response> {
  const gate = await mobileAuth();
  if (!gate.ok) return gate.response;

  const params = new URL(request.url).searchParams;
  const phase = params.get("phase");
  const page = parsePage(params);
  if (!page) return json({ error: "invalid query" }, 400);

  // null means both sections; "needs" or "earlier" narrows to one.
  if (phase !== null && phase !== "needs" && phase !== "earlier") {
    return json({ error: "invalid query" }, 400);
  }

  const rows = await listAllReports();
  const cards: InboxCard[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    sourceLabel: row.sourceLabel,
    channel: row.channel,
    targetName: row.targetName,
    outcome: row.outcome,
    verdictSuperseded: row.verdictSuperseded,
    deliveryState: row.deliveryState,
    state: row.state,
    awaitingVerdictId: row.awaitingVerdictId,
    updatedAt: row.updatedAt,
  }));

  const needsYou = cards.filter((row) => row.awaitingVerdictId !== null);
  const earlier = cards.filter((row) => row.awaitingVerdictId === null);

  if (phase === "needs") {
    const { items, total, nextOffset } = paginate(needsYou, page);
    return json({ needsYou: { items, total, nextOffset }, earlier: null });
  }
  if (phase === "earlier") {
    const { items, total, nextOffset } = paginate(earlier, page);
    return json({ needsYou: null, earlier: { items, total, nextOffset } });
  }

  const needsPage = paginate(needsYou, page);
  const earlierPage = paginate(earlier, page);
  return json({
    needsYou: { items: needsPage.items, total: needsYou.length, nextOffset: needsPage.nextOffset },
    earlier: { items: earlierPage.items, total: earlier.length, nextOffset: earlierPage.nextOffset },
  });
}
