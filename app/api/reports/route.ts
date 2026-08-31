import { currentSession } from "@/lib/auth/dal";
import { listAllReports, phaseOf } from "@/lib/reports/queue";

export const runtime = "nodejs";

/** Every report, closed ones included. The shape reports-table.tsx already renders. */
export async function GET(): Promise<Response> {
  const session = await currentSession();
  if (!session) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const rows = await listAllReports();

  return Response.json(
    rows.map((row) => ({
      ...row,
      phase: phaseOf(row.state),
      updatedAt: row.updatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
    { headers: { "cache-control": "no-store" } },
  );
}
