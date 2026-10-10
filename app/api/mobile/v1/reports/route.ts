import { report } from "@/lib/db/schema";
import { json, jsonError, mobileAuth } from "@/lib/mobile/auth";
import { paginate, parsePage } from "@/lib/mobile/views";
import { listAllReports, phaseOf } from "@/lib/reports/queue";

export const runtime = "nodejs";

/**
 * Every report, closed ones included, newest change first. `q` matches title, source, target and
 * origin; `state` filters to one lifecycle state. Filtering runs over the same 200-row read the
 * web index uses, so the search is as wide as that page's.
 */
export async function GET(request: Request): Promise<Response> {
  const gate = await mobileAuth();
  if (!gate.ok) return gate.response;

  const params = new URL(request.url).searchParams;
  const page = parsePage(params);
  const state = params.get("state");
  if (!page || (state !== null && !(report.state.enumValues as readonly string[]).includes(state))) {
    return jsonError("invalid query", 400);
  }
  const needle = (params.get("q") ?? "").trim().toLowerCase();

  const rows = (await listAllReports()).filter(
    (row) =>
      (state === null || row.state === state) &&
      (needle === "" ||
        [row.title, row.sourceLabel, row.targetName ?? "", row.origin].some((field) =>
          field.toLowerCase().includes(needle),
        )),
  );

  const { items, total, nextOffset } = paginate(rows, page);
  return json({
    reports: items.map((row) => ({
      ...row,
      phase: phaseOf(row.state),
      updatedAt: row.updatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
    total,
    nextOffset,
  });
}
