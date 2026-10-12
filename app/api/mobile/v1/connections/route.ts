import { connectionRows } from "@/app/(app)/connections/rows";
import { connectedRepository, db } from "@/lib/db";
import { json, mobileAuth } from "@/lib/mobile/auth";

export const runtime = "nodejs";

/**
 * The connections table, read-only: the same rows the web page renders, plus `branch`.
 *
 * branch is connected_repository.latest_pushed_branch, the default branch the push webhook (or
 * the reconcile tick) last saw. It is null until a push has been seen for that repository;
 * nothing stores the default branch any earlier, and GitHub is not called per request.
 */
export async function GET(): Promise<Response> {
  const gate = await mobileAuth();
  if (!gate.ok) return gate.response;

  const [rows, branches] = await Promise.all([
    connectionRows(),
    db.select({ id: connectedRepository.id, branch: connectedRepository.latestPushedBranch }).from(connectedRepository),
  ]);
  const byRow = new Map(branches.map((row) => [`repo-${row.id}`, row.branch]));
  return json(rows.map((row) => ({ ...row, branch: byRow.get(row.id) ?? null })));
}
