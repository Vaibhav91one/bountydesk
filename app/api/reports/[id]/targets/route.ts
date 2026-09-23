import { currentSession } from "@/lib/auth/dal";
import { db, eq, report } from "@/lib/db";
import { isReportId } from "@/lib/reports/case";
import { listTargetProfiles } from "@/lib/targets/bind";
import { suggestTargets } from "@/lib/targets/suggest";

export const runtime = "nodejs";

/**
 * The target picker's options and the report's link suggestions, polled while a reviewer works
 * through connecting a repository, so a fork that finishes onboarding shows up without a reload.
 *
 * 401 rather than requireReviewer's redirect, for the same reason as the status route: a fetch
 * follows the redirect and would try to parse the login page as JSON.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await context.params;
  if (!isReportId(id)) return Response.json({ error: "report not found" }, { status: 404 });

  const [row] = await db
    .select({ body: report.body, channel: report.channel, targetProfileId: report.targetProfileId })
    .from(report)
    .where(eq(report.id, id))
    .limit(1);
  if (!row) return Response.json({ error: "report not found" }, { status: 404 });

  // The same rule as the case page: only an unbound report offers a choice, and only an email
  // report is read for links.
  const unbound = row.targetProfileId === null;
  const profiles = unbound ? await listTargetProfiles() : [];
  const suggestion = unbound && row.channel === "email" ? await suggestTargets(row.body) : null;
  return Response.json({ profiles, suggestion }, { headers: { "cache-control": "no-store" } });
}
