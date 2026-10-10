import { json, jsonError, mobileAuth } from "@/lib/mobile/auth";
import { paginate, parsePage } from "@/lib/mobile/views";
import { COLUMNS, listQueue } from "@/lib/reports/queue";
import { queueColumnViews } from "@/lib/reports/queue-view";

export const runtime = "nodejs";

/**
 * The review board grouped by phase. `limit` and `offset` page the cards inside each column, and
 * `phase` narrows the answer to one column to keep paging it.
 *
 * ponytail: listQueue already caps a column at COLUMN_LIMIT cards, so `total` can exceed what
 * paging reaches. Push offset into the SQL if the board ever needs to go past that cap.
 */
export async function GET(request: Request): Promise<Response> {
  const gate = await mobileAuth();
  if (!gate.ok) return gate.response;

  const params = new URL(request.url).searchParams;
  const page = parsePage(params);
  const phase = params.get("phase");
  if (!page || (phase !== null && !COLUMNS.some((column) => column.key === phase))) {
    return jsonError("invalid query", 400);
  }

  const columns = queueColumnViews(await listQueue())
    .filter((column) => phase === null || column.key === phase)
    .map((column) => {
      const { items, nextOffset } = paginate(column.cards, page);
      return { key: column.key, label: column.label, total: column.total, cards: items, nextOffset };
    });
  return json({ columns });
}
