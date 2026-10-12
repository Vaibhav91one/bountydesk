import { db } from "@/lib/db";
import { json, mobileAuth } from "@/lib/mobile/auth";
import { extrasFor, readCardExtras } from "@/lib/mobile/card-extras";
import { paginate, parsePage, type InboxCard } from "@/lib/mobile/views";
import { INDEX_LIMIT, listAllReports, listAwaitingReview } from "@/lib/reports/queue";

export const runtime = "nodejs";

/**
 * The inbox for M23: "needs you" (reports awaiting a verdict decision) and "earlier" (delivered,
 * denied, expired, etc.), newest first.
 *
 * "needs you" comes from listAwaitingReview, which has no cap: an old awaiting report must never
 * vanish just because 200 newer rows exist. "earlier" comes from listAllReports, which is capped
 * at INDEX_LIMIT by design for the reports index, so the earlier section carries `truncated` when
 * the cap was hit and the full set may be larger.
 *
 * Both reads share one repeatable-read snapshot, so a state change between them cannot drop a
 * report from one section and resurface it in the other. Within one snapshot a report is either
 * awaiting (in needsYou) or not (in earlier), never both.
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

  // One snapshot for both reads: a report that is awaiting at this moment must not also show up
  // in "earlier", and vice versa. Read-only so a serialisation failure is safe to surface as 500.
  const { needsCards, earlierCards, allRows } = await db.transaction(
    async (tx) => {
      const awaiting = await listAwaitingReview(tx);
      const allRows = await listAllReports(INDEX_LIMIT, tx);
      // NEEDS_DECISION reports also have a null awaitingVerdictId, so filtering by that field alone
      // would put them in both sections. Exclude by id instead: a report is either awaiting or earlier.
      const needsIds = new Set(awaiting.map((row) => row.id));
      const earlierRows = allRows.filter((row) => !needsIds.has(row.id));

      const needsCards: InboxCard[] = awaiting.map((row) => ({
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

      const earlierCards: InboxCard[] = earlierRows.map((row) => ({
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

      return { needsCards, earlierCards, allRows };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  // Page first, then one batched read of the extras for just the cards returned.
  const needsPage = paginate(needsCards, page);
  const earlierPage = paginate(earlierCards, page);
  const shown = [
    ...(phase === "earlier" ? [] : needsPage.items),
    ...(phase === "needs" ? [] : earlierPage.items),
  ];
  const extras = await readCardExtras(shown.map((card) => card.id));
  const decorate = (items: InboxCard[]) => items.map((card) => ({ ...card, ...extrasFor(extras, card.id) }));
  const truncated = allRows.length >= INDEX_LIMIT;

  if (phase === "needs") {
    return json({
      needsYou: { items: decorate(needsPage.items), total: needsPage.total, nextOffset: needsPage.nextOffset },
      earlier: null,
    });
  }
  if (phase === "earlier") {
    return json({
      needsYou: null,
      earlier: { items: decorate(earlierPage.items), total: earlierPage.total, nextOffset: earlierPage.nextOffset, truncated },
    });
  }
  return json({
    needsYou: { items: decorate(needsPage.items), total: needsCards.length, nextOffset: needsPage.nextOffset },
    earlier: {
      items: decorate(earlierPage.items),
      total: earlierCards.length,
      nextOffset: earlierPage.nextOffset,
      truncated,
    },
  });
}
