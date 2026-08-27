import { db, sql, verdict, type Executor } from "@/lib/db";

/**
 * Raised when a retried write disagrees with the verdict already on record.
 *
 * ensureInitialVerdict is called by code that may run twice for the same report (a retried
 * job, a heartbeat that lost its lease after the transaction committed). Two different
 * pieces of code disagreeing about what a report's verdict says must never happen silently,
 * so a mismatch is a hard failure rather than a coin flip over which write wins.
 */
export class VerdictIntegrityError extends Error {
  constructor(reportId: string, mismatch: string) {
    super(`verdict for report ${reportId} already exists and disagrees on ${mismatch}`);
    this.name = "VerdictIntegrityError";
  }
}

export type NewInitialVerdict = {
  // Caller-generated: the marker embedded in payload has to reference this id, so the id
  // must exist before the payload text is composed and hashed, not be left to the database
  // to assign after the fact.
  id: string;
  reportId: string;
  outcome: (typeof verdict.outcome.enumValues)[number];
  summary: string;
  evidence?: Record<string, unknown>;
  payload: string;
  contentHash: string;
};

export type Verdict = {
  id: string;
  outcome: string;
  payload: string;
  contentHash: string;
};

/**
 * Create the first revision of a report's verdict, or return the one that already exists.
 *
 * Hardcoded to revision 1: a real driver revising a verdict later is out of scope here, and
 * calling this ensureInitialVerdict rather than createVerdict says so. Mirrors ensureReport's
 * shape in lib/reports/lifecycle.ts: an insert that loses the race falls back to reading the
 * row that won, and the database's unique (report_id, revision) index is the arbiter, not a
 * read-then-write in application code.
 */
export async function ensureInitialVerdict(
  input: NewInitialVerdict,
  tx: Executor = db,
): Promise<Verdict> {
  const inserted = await tx
    .insert(verdict)
    .values({
      id: input.id,
      reportId: input.reportId,
      outcome: input.outcome,
      summary: input.summary,
      evidence: input.evidence ?? {},
      payload: input.payload,
      contentHash: input.contentHash,
      revision: 1,
    })
    .onConflictDoNothing({ target: [verdict.reportId, verdict.revision] })
    .returning({
      id: verdict.id,
      outcome: verdict.outcome,
      payload: verdict.payload,
      contentHash: verdict.contentHash,
    });

  if (inserted.length > 0) return inserted[0];

  const [existing] = await tx
    .select({
      id: verdict.id,
      outcome: verdict.outcome,
      payload: verdict.payload,
      contentHash: verdict.contentHash,
    })
    .from(verdict)
    .where(sql`${verdict.reportId} = ${input.reportId} and ${verdict.revision} = 1`)
    .limit(1);

  if (!existing) {
    throw new Error(`ensureInitialVerdict: conflict on report ${input.reportId} but no row found`);
  }

  if (existing.outcome !== input.outcome) {
    throw new VerdictIntegrityError(input.reportId, "outcome");
  }
  if (existing.payload !== input.payload) {
    throw new VerdictIntegrityError(input.reportId, "payload");
  }
  if (existing.contentHash !== input.contentHash) {
    throw new VerdictIntegrityError(input.reportId, "contentHash");
  }

  return existing;
}
