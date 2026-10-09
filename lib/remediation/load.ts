import { and, artifact, db, desc, eq, verdict } from "@/lib/db";
import { verdictFindings } from "@/lib/reports/case-facts";

import { buildRemediationPatch } from "./patch";

/**
 * The patch for a report's newest verdict that has a recorded remediation-patch artifact.
 *
 * The artifact row is the eligibility record (REPRODUCED, bound target, patch validated when the
 * verdict was drafted). The bytes are rebuilt from the verdict's stored evidence rather than read
 * back from Storage, so the download works when Storage is not configured and cannot drift from
 * the sha256 the row recorded.
 */
export async function loadRemediationPatch(
  reportId: string,
): Promise<{ filename: string; patch: string } | null> {
  const [row] = await db
    .select({ evidence: verdict.evidence, revision: verdict.revision })
    .from(artifact)
    .innerJoin(verdict, eq(verdict.id, artifact.verdictId))
    .where(and(eq(artifact.reportId, reportId), eq(artifact.kind, "remediation-patch")))
    .orderBy(desc(verdict.revision))
    .limit(1);
  if (!row) return null;
  const patch = buildRemediationPatch(verdictFindings(row.evidence));
  return patch
    ? { filename: `bountydesk-${reportId.slice(0, 8)}-r${row.revision}.diff`, patch }
    : null;
}
