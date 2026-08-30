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
  type Executor,
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
export async function readScope(tx: Executor = db): Promise<ScopeProfile[]> {
  const rows = await tx
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
export async function readDecisions(tx: Executor = db): Promise<AuditDecision[]> {
  return tx
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
export async function readAttempts(tx: Executor = db): Promise<AuditAttempt[]> {
  return tx
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

/**
 * All three tabs from one snapshot.
 *
 * Sequential rather than Promise.all: one transaction is one connection, and concurrent
 * queries on it would serialise anyway or error, depending on the driver. Read-only and
 * repeatable read for the same reason the board is, so a decision landing between the scope
 * read and the audit read cannot produce a page describing two different moments.
 */
export async function readSettings(): Promise<{
  profiles: ScopeProfile[];
  decisions: AuditDecision[];
  attempts: AuditAttempt[];
}> {
  return db.transaction(
    async (tx) => ({
      profiles: await readScope(tx),
      decisions: await readDecisions(tx),
      attempts: await readAttempts(tx),
    }),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
