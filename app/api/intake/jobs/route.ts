import { currentSession } from "@/lib/auth/dal";
import { readRecentIntakeJobs, visibleIntakeJobs } from "@/lib/intake/jobs-read";

export const runtime = "nodejs";

/** Payload-free intake watch for the board strip. Browser input never reaches the query. */
export async function GET(): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const jobs = visibleIntakeJobs(await readRecentIntakeJobs());
  return Response.json({ jobs }, { headers: { "cache-control": "no-store" } });
}
