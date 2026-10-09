import { currentSession } from "@/lib/auth/dal";
import { isReportId } from "@/lib/reports/case";
import { renderReportExport } from "@/lib/reports/export";

export const runtime = "nodejs";

/** One downloadable Markdown document bundling a report's approved verdict, its findings and
 * its investigation transcript. See renderReportExport: a report with no approved verdict yet
 * has nothing to export. Read-only, so a plain GET behind a reviewer session is enough; no
 * write-access check needed, same as the per-file artifact downloads. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await context.params;
  if (!isReportId(id)) return Response.json({ error: "report not found" }, { status: 404 });

  const result = await renderReportExport(id);
  if (!result.ok) return Response.json({ error: result.reason }, { status: 404 });

  return new Response(result.markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${result.filename}"`,
      "cache-control": "no-store",
    },
  });
}
