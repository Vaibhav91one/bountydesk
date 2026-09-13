import { db, eq, sql, verdict, type Executor } from "@/lib/db";
import { isDeepStrictEqual } from "node:util";

import { computeContentHash } from "./hash";

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
    super(
      `verdict for report ${reportId} already exists and disagrees on ${mismatch}`,
    );
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
};

export type Verdict = {
  id: string;
  outcome: string;
  summary: string;
  evidence: unknown;
  payload: string;
  contentHash: string;
};

/**
 * The revision a re-check run's draft becomes: one past the highest revision on record. The
 * agent-drafted path (lib/mcp/publish-verdict.ts) reads this inside its own transaction, so a
 * concurrent draft lands at a different revision through the unique (report_id, revision)
 * index rather than a race in application code.
 */
export async function nextVerdictRevision(
  reportId: string,
  tx: Executor = db,
): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${verdict.revision})` })
    .from(verdict)
    .where(eq(verdict.reportId, reportId));
  return (row?.max ?? 0) + 1;
}

/**
 * Create revision N+1 of a report's verdict: what a re-check run drafts. Unlike
 * ensureInitialVerdict this never reconciles with an existing row: each call is a new
 * revision of the agent's own fresh conclusion, and two drafts from the same run would be a
 * bug worth failing loudly on, not a retry to deduplicate. The database's unique
 * (report_id, revision) index is the backstop if the max read races.
 */
export async function appendVerdictRevision(
  input: NewInitialVerdict & { revision: number },
  tx: Executor = db,
): Promise<Verdict> {
  if (input.revision <= 1) {
    throw new Error(`appendVerdictRevision: revision ${input.revision} is not a follow-up`);
  }
  const marker = `<!-- bountydesk-delivery:${input.id} -->`;
  if (input.payload.split(marker).length !== 2) {
    throw new VerdictIntegrityError(input.reportId, "delivery marker");
  }
  const contentHash = computeContentHash(input.payload);
  const evidence = input.evidence ?? {};

  const inserted = await tx
    .insert(verdict)
    .values({
      id: input.id,
      reportId: input.reportId,
      outcome: input.outcome,
      summary: input.summary,
      evidence,
      payload: input.payload,
      contentHash,
      revision: input.revision,
    })
    .onConflictDoNothing({ target: [verdict.reportId, verdict.revision] })
    .returning({
      id: verdict.id,
      outcome: verdict.outcome,
      summary: verdict.summary,
      evidence: verdict.evidence,
      payload: verdict.payload,
      contentHash: verdict.contentHash,
    });

  if (inserted.length > 0) return inserted[0];
  throw new VerdictIntegrityError(input.reportId, `revision ${input.revision} already exists`);
}

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
  const marker = `<!-- bountydesk-delivery:${input.id} -->`;
  if (input.payload.split(marker).length !== 2) {
    throw new VerdictIntegrityError(input.reportId, "delivery marker");
  }
  const contentHash = computeContentHash(input.payload);
  const evidence = input.evidence ?? {};

  const inserted = await tx
    .insert(verdict)
    .values({
      id: input.id,
      reportId: input.reportId,
      outcome: input.outcome,
      summary: input.summary,
      evidence,
      payload: input.payload,
      contentHash,
      revision: 1,
    })
    .onConflictDoNothing({ target: [verdict.reportId, verdict.revision] })
    .returning({
      id: verdict.id,
      outcome: verdict.outcome,
      summary: verdict.summary,
      evidence: verdict.evidence,
      payload: verdict.payload,
      contentHash: verdict.contentHash,
    });

  if (inserted.length > 0) return inserted[0];

  const [existing] = await tx
    .select({
      id: verdict.id,
      outcome: verdict.outcome,
      summary: verdict.summary,
      evidence: verdict.evidence,
      payload: verdict.payload,
      contentHash: verdict.contentHash,
    })
    .from(verdict)
    .where(
      sql`${verdict.reportId} = ${input.reportId} and ${verdict.revision} = 1`,
    )
    .limit(1);

  if (!existing) {
    throw new Error(
      `ensureInitialVerdict: conflict on report ${input.reportId} but no row found`,
    );
  }

  if (existing.outcome !== input.outcome) {
    throw new VerdictIntegrityError(input.reportId, "outcome");
  }
  if (existing.summary !== input.summary) {
    throw new VerdictIntegrityError(input.reportId, "summary");
  }
  if (!isDeepStrictEqual(existing.evidence, evidence)) {
    throw new VerdictIntegrityError(input.reportId, "evidence");
  }
  if (existing.payload !== input.payload) {
    throw new VerdictIntegrityError(input.reportId, "payload");
  }
  if (existing.contentHash !== contentHash) {
    throw new VerdictIntegrityError(input.reportId, "contentHash");
  }

  return existing;
}
