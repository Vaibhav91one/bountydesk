import { currentSession } from "@/lib/auth/dal";
import { loadRemediationPatch } from "@/lib/remediation/load";
import { isReportId } from "@/lib/reports/case";

export const runtime = "nodejs";

/** A suggested fix as a unified diff, for a reviewer to read and apply by hand. Served as an
 * attachment and never applied by the platform. Same reviewer-session gate as the export. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await context.params;
  if (!isReportId(id)) return Response.json({ error: "report not found" }, { status: 404 });

  const result = await loadRemediationPatch(id);
  if (!result) return Response.json({ error: "no remediation patch" }, { status: 404 });

  return new Response(result.patch, {
    headers: {
      "content-type": "text/x-diff; charset=utf-8",
      "content-disposition": `attachment; filename="${result.filename}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
