import { currentSession } from "@/lib/auth/dal";
import { isReviewer } from "@/lib/auth/reviewers";

import { connectionRows } from "@/app/(app)/connections/rows";

export const runtime = "nodejs";

/** The connections table, polled by the panel. Reviewer-gated, the same as the page, and returns the
 *  same rows the page renders for first paint. */
export async function GET(): Promise<Response> {
  const session = await currentSession();
  if (!session || !isReviewer(session.userId)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  return Response.json(await connectionRows(), {
    headers: { "cache-control": "no-store" },
  });
}
