import { and, desc, eq, report, sessionEvent, verdict, type Executor } from "@/lib/db";
import {
  isStaticFallbackReason,
  STATIC_FALLBACK_EVENT,
  type StaticFallbackReason,
} from "@/lib/analysis/static-review";

import { recordEvent, transition } from "./lifecycle";

export type StaticFallback = { reason: StaticFallbackReason; sourceFiles: string[] };

/**
 * The static fallback recorded with this report's turn (lib/analysis/trueforge-driver.ts), or null
 * when its turn was an ordinary one. The event is written in the same transaction that stored the
 * turn, and session_event rows cannot be edited, so this is server-authored and stable.
 */
export async function readStaticFallback(reportId: string, tx: Executor): Promise<StaticFallback | null> {
  const [row] = await tx
    .select({ data: sessionEvent.data })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.reportId, reportId), eq(sessionEvent.type, STATIC_FALLBACK_EVENT)))
    .orderBy(desc(sessionEvent.seq))
    .limit(1);
  const data = row?.data as { reason?: unknown; sourceFiles?: unknown } | undefined;
  if (!isStaticFallbackReason(data?.reason)) return null;
  const sourceFiles = Array.isArray(data.sourceFiles)
    ? data.sourceFiles.filter((f): f is string => typeof f === "string")
    : [];
  return { reason: data.reason, sourceFiles };
}

export type OutOfScopeRouting =
  | { routed: true }
  | { routed: false; reason: "missing" | "not-triaging" | "no-static-fallback" | "source-was-read" | "has-verdict" };

const DETAIL: Record<StaticFallbackReason, string> = {
  COULD_NOT_BUILD: "the target could not be built",
  COULD_NOT_DEPLOY: "the target could not be deployed",
};

/**
 * Route a report that can be neither reproduced nor analyzed to the terminal OUT_OF_SCOPE.
 *
 * A target that cannot be built or deployed gets a static review instead of a reproduction, and
 * that review ends ANALYSIS_ONLY whenever it produces anything. This is the narrow case left over:
 * the review had no source to read and its turn then ended without drafting a verdict, so there is
 * nothing to reproduce against and nothing a reviewer could approve. The caller (the poller's
 * dead-end path) has already established that the turn produced nothing; this function checks the
 * rest against the database.
 *
 * The refusals keep the state honest. OUT_OF_SCOPE needs a recorded static fallback, which exists
 * only when onboarding recorded COULD_NOT_BUILD, an upload build gave up, or provisioning threw a
 * hard deploy failure, so it is never produced from the mere absence of a target. A review that read source, or a report that
 * already has a verdict, stays on the ANALYSIS_ONLY path. A report that already left TRIAGING is
 * left alone. Runs in the caller's transaction, which must hold the report row lock.
 */
export async function routeUnreproducibleTarget(reportId: string, tx: Executor): Promise<OutOfScopeRouting> {
  const [row] = await tx
    .select({ state: report.state })
    .from(report)
    .where(eq(report.id, reportId))
    .for("update");
  if (!row) return { routed: false, reason: "missing" };
  if (row.state !== "TRIAGING") return { routed: false, reason: "not-triaging" };

  const fallback = await readStaticFallback(reportId, tx);
  if (!fallback) return { routed: false, reason: "no-static-fallback" };
  if (fallback.sourceFiles.length > 0) return { routed: false, reason: "source-was-read" };

  const [existing] = await tx.select({ id: verdict.id }).from(verdict).where(eq(verdict.reportId, reportId)).limit(1);
  if (existing) return { routed: false, reason: "has-verdict" };

  await transition(reportId, "TRIAGING", "OUT_OF_SCOPE", tx);
  await recordEvent(
    reportId,
    "target.out_of_scope",
    {
      reason: fallback.reason,
      detail: `${DETAIL[fallback.reason]}, no source was reachable for a static review, and the review drafted nothing`,
    },
    { tx },
  );
  return { routed: true };
}
