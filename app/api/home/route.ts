import { currentSession } from "@/lib/auth/dal";
import { readHomeSummary } from "@/lib/home/summary";

export const runtime = "nodejs";

/** The counts on the home cards. Five integers, so no serialization step. */
export async function GET(): Promise<Response> {
  const session = await currentSession();
  if (!session) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  return Response.json(await readHomeSummary(), {
    headers: { "cache-control": "no-store" },
  });
}
