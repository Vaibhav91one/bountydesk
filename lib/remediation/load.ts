import { and, artifact, db, desc, eq, verdict } from "@/lib/db";
import { verdictFindings } from "@/lib/reports/case-facts";

import { buildRemediationPatch } from "./patch";

/**
 * The patch for a report's current (newest) verdict, if that verdict has a recorded
 * remediation-patch artifact. A superseded revision's patch is not served: after a re-check the
 * live verdict may no longer claim the finding is reproduced.
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
    .select({ evidence: verdict.evidence, revision: verdict.revision, patchId: artifact.id })
    .from(verdict)
    .leftJoin(
      artifact,
      and(eq(artifact.verdictId, verdict.id), eq(artifact.kind, "remediation-patch")),
    )
    .where(eq(verdict.reportId, reportId))
    .orderBy(desc(verdict.revision))
    .limit(1);
  if (!row?.patchId) return null;
  const patch = buildRemediationPatch(verdictFindings(row.evidence));
  return patch
    ? { filename: `bountydesk-${reportId.slice(0, 8)}-r${row.revision}.diff`, patch }
    : null;
}
