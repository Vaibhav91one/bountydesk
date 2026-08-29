import {
  approvalDecision,
  connectedRepository,
  db,
  deliveryAttempt,
  desc,
  eq,
  outboundDelivery,
  report,
  targetProfile,
  verdict,
} from "@/lib/db";

/**
 * What the settings screens read.
 *
 * Display only, like the board and the case file. Nothing here is editable, and that is not an
 * oversight: a target profile is what the scope guard binds every clone, deploy and egress to,
 * so it is server-held on purpose and does not get a form until there is a story for who may
 * change one and what happens to a run already bound to it.
 */

/** The audit tab is a recent view, not an export. */
const AUDIT_LIMIT = 30;

export type ScopeProfile = {
  id: string;
  name: string;
  imageName: string | null;
  imageDigest: string;
  snapshotId: string | null;
  /** How many host and path rules the guard is holding for this profile. */
  ruleCount: number;
  repositories: string[];
};

export type AuditDecision = {
  id: string;
  reviewer: string;
  decision: string;
  payloadHash: string;
  note: string | null;
  decidedAt: Date;
  reportId: string;
  reportTitle: string;
  revision: number;
};

export type AuditAttempt = {
  id: string;
  attempt: number;
  responseStatus: number | null;
  error: string | null;
  finishedAt: Date;
  target: string;
  reportId: string;
  reportTitle: string;
};

/**
 * Every authorised target, and which connected repositories are bound to it.
 *
 * A profile with no repository is not an error. It is a target nothing has been pointed at
 * yet, and dropping it would hide half of what the guard would accept.
 */
export async function readScope(): Promise<ScopeProfile[]> {
  const rows = await db
    .select({
      id: targetProfile.id,
      name: targetProfile.name,
      imageName: targetProfile.imageName,
      imageDigest: targetProfile.imageDigest,
      snapshotId: targetProfile.snapshotId,
      scopeRules: targetProfile.scopeRules,
      repository: connectedRepository.fullName,
    })
    .from(targetProfile)
    .leftJoin(connectedRepository, eq(connectedRepository.targetProfileId, targetProfile.id))
    .orderBy(targetProfile.name);

  const byId = new Map<string, ScopeProfile>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    if (existing) {
      if (row.repository) existing.repositories.push(row.repository);
      continue;
    }

    byId.set(row.id, {
      id: row.id,
      name: row.name,
      imageName: row.imageName,
      imageDigest: row.imageDigest,
      snapshotId: row.snapshotId,
      ruleCount: Array.isArray(row.scopeRules) ? row.scopeRules.length : 0,
      repositories: row.repository ? [row.repository] : [],
    });
  }

  return [...byId.values()];
}

/** Who signed what, newest first. The table refuses UPDATE and DELETE, so this is the record. */
export async function readDecisions(): Promise<AuditDecision[]> {
  return db
    .select({
      id: approvalDecision.id,
      reviewer: approvalDecision.reviewer,
      decision: approvalDecision.decision,
      payloadHash: approvalDecision.payloadHash,
      note: approvalDecision.note,
      decidedAt: approvalDecision.decidedAt,
      reportId: report.id,
      reportTitle: report.title,
      revision: verdict.revision,
    })
    .from(approvalDecision)
    .innerJoin(verdict, eq(approvalDecision.verdictId, verdict.id))
    .innerJoin(report, eq(verdict.reportId, report.id))
    .orderBy(desc(approvalDecision.decidedAt))
    .limit(AUDIT_LIMIT);
}

/** Every outbound attempt, successful or not. Also append-only. */
export async function readAttempts(): Promise<AuditAttempt[]> {
  return db
    .select({
      id: deliveryAttempt.id,
      attempt: deliveryAttempt.attempt,
      responseStatus: deliveryAttempt.responseStatus,
      error: deliveryAttempt.error,
      finishedAt: deliveryAttempt.finishedAt,
      target: outboundDelivery.target,
      reportId: report.id,
      reportTitle: report.title,
    })
    .from(deliveryAttempt)
    .innerJoin(outboundDelivery, eq(deliveryAttempt.deliveryId, outboundDelivery.id))
    .innerJoin(report, eq(outboundDelivery.reportId, report.id))
    .orderBy(desc(deliveryAttempt.finishedAt))
    .limit(AUDIT_LIMIT);
}
