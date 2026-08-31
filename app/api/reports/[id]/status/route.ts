import { requireReviewer } from "@/lib/auth/dal";
import { isReportId, readCase } from "@/lib/reports/case";
import { caseStatusView } from "@/lib/reports/status-view";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireReviewer();

  const { id } = await context.params;
  if (!isReportId(id)) {
    return Response.json({ error: "report not found" }, { status: 404 });
  }

  const file = await readCase(id);
  if (!file) {
    return Response.json({ error: "report not found" }, { status: 404 });
  }

  return Response.json(caseStatusView(file), {
    headers: { "cache-control": "no-store" },
  });
}
