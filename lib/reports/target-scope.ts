import { db, eq, report } from "@/lib/db";

import { recordEvent, transition } from "./lifecycle";

export type OutOfScopeRouting =
  | { routed: true }
  | { routed: false; reason: "missing" | "no-bound-target" | "not-triaging" };

/**
 * Route a report whose bound target is a hard dead end to the terminal OUT_OF_SCOPE.
 *
 * "Hard dead end" is the caller's determination, not this function's: the pinned target cannot be
 * built or booted at all (a ProvisionCouldNotDeployError from lib/sandbox/provision), so there is
 * nothing to reproduce against and no later run would fix it. That is what the user means by out of
 * scope, a target we can neither reproduce against nor turn into a useful analysis. It is different
 * from a target that is merely unavailable this run (Daytona down, the app slow to answer), which
 * stays ANALYSIS_ONLY because it may be reachable next run and the report text still yields an
 * analysis a human can act on.
 *
 * Two refusals keep the invariant honest. A report with no bound target never becomes OUT_OF_SCOPE,
 * so the state is never produced from the absence of a target (no bound target means ANALYSIS_ONLY,
 * unchanged). And a report that has already left TRIAGING is left alone, so a concurrent transition
 * is never overwritten: the row lock plus transition's own compare-and-swap make that safe.
 */
export async function routeUnreproducibleTarget(
  reportId: string,
  reason: string,
): Promise<OutOfScopeRouting> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ state: report.state, targetProfileId: report.targetProfileId })
      .from(report)
      .where(eq(report.id, reportId))
      .for("update");

    if (!row) return { routed: false, reason: "missing" };
    if (!row.targetProfileId) return { routed: false, reason: "no-bound-target" };
    if (row.state !== "TRIAGING") return { routed: false, reason: "not-triaging" };

    await transition(reportId, "TRIAGING", "OUT_OF_SCOPE", tx);
    await recordEvent(reportId, "target.out_of_scope", { reason }, { tx });
    return { routed: true };
  });
}
