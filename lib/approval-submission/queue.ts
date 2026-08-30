import { and, eq, lte, or, sql } from "drizzle-orm";

import { approvalSubmission, db, type Executor } from "@/lib/db";

/**
 * approval_submission has no maxAttempts column (unlike inbound_job and outbound_delivery):
 * telling TrueForge about a decision is a single, narrow call with no per-row reason to tune
 * its retry budget, so a fixed constant is enough. Mirrors outbound_delivery's default.
 */
export const MAX_ATTEMPTS = 8;

export type ApprovalSubmissionState = "PENDING" | "SUBMITTED" | "ACKNOWLEDGED" | "FAILED";

/** A held approval_submission row. Mirrors lib/jobs/queue.ts's Lease and lib/delivery/queue.ts's DeliveryLease. */
export type ApprovalSubmissionLease = {
  id: string;
  agentSessionId: string;
  approvalDecisionId: string;
  attempts: number;
  fence: number;
  leaseOwner: string;
};

/** Raised when a mutation is attempted with a lease that is no longer the current one. */
export class LeaseLostError extends Error {
  constructor(approvalSubmissionId: string) {
    super(
      `lease on approval submission ${approvalSubmissionId} is no longer held by this worker; another worker has taken over`,
    );
    this.name = "LeaseLostError";
  }
}

/**
 * Take exactly one submittable row, atomically. Same FOR UPDATE SKIP LOCKED shape as
 * lib/jobs/queue.ts's claim.
 *
 * Claimable means PENDING or FAILED, attempts remaining, backoff elapsed, and either unheld
 * or the prior holder's lease expired. FAILED only appears here with attempts remaining if
 * something resets nextAttemptAt by hand; fail() itself only reaches FAILED once attempts
 * are exhausted, at which point this attempts guard excludes it anyway.
 */
export async function claim(
  owner: string,
  leaseSeconds = 60,
): Promise<ApprovalSubmissionLease | null> {
  const rows = await db.execute<{
    id: string;
    agent_session_id: string;
    approval_decision_id: string;
    attempts: number;
    fence: string | number;
  }>(sql`
    update ${approvalSubmission}
       set lease_owner      = ${owner},
           lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           attempts         = ${approvalSubmission.attempts} + 1,
           fence            = ${approvalSubmission.fence} + 1,
           updated_at       = now()
     where ${approvalSubmission.id} = (
       select ${approvalSubmission.id}
         from ${approvalSubmission}
        where ${approvalSubmission.state} in ('PENDING', 'FAILED')
          and ${approvalSubmission.attempts} < ${MAX_ATTEMPTS}
          and ${approvalSubmission.nextAttemptAt} <= now()
          and (${approvalSubmission.leaseExpiresAt} is null or ${approvalSubmission.leaseExpiresAt} < now())
        order by ${approvalSubmission.nextAttemptAt}
        limit 1
        for update skip locked
     )
    returning ${approvalSubmission.id}                 as id,
              ${approvalSubmission.agentSessionId}      as agent_session_id,
              ${approvalSubmission.approvalDecisionId}  as approval_decision_id,
              ${approvalSubmission.attempts}            as attempts,
              ${approvalSubmission.fence}               as fence
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    agentSessionId: row.agent_session_id,
    approvalDecisionId: row.approval_decision_id,
    attempts: row.attempts,
    fence: Number(row.fence),
    leaseOwner: owner,
  };
}

/** Scopes an update to the exact lease the caller holds. */
function heldBy(lease: ApprovalSubmissionLease) {
  return and(
    eq(approvalSubmission.id, lease.id),
    eq(approvalSubmission.leaseOwner, lease.leaseOwner),
    eq(approvalSubmission.fence, lease.fence),
    sql`${approvalSubmission.leaseExpiresAt} > now()`,
  );
}

/** Extend a held lease without changing its owner or fence. */
export async function renew(
  lease: ApprovalSubmissionLease,
  leaseSeconds: number,
): Promise<void> {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error("leaseSeconds must be greater than zero");
  }

  const updated = await db
    .update(approvalSubmission)
    .set({
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
      updatedAt: new Date(),
    })
    .where(heldBy(lease))
    .returning({ id: approvalSubmission.id });

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/** Return a deadline-aborted claim without consuming its attempt budget. */
export async function releaseUnstarted(lease: ApprovalSubmissionLease): Promise<void> {
  const updated = await db
    .update(approvalSubmission)
    .set({
      attempts: sql`greatest(${approvalSubmission.attempts} - 1, 0)`,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(heldBy(lease))
    .returning({ id: approvalSubmission.id });

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/** Mark a submission acknowledged by TrueForge and drop the lease. */
export async function markSubmitted(
  lease: ApprovalSubmissionLease,
  // null when there was no TrueForge turn to record: a synthesized ANALYSIS_ONLY verdict is
  // delivered without a harness round-trip, so the submission closes with no submitted turn id.
  submittedTurnId: string | null,
  tx: Executor = db,
): Promise<void> {
  const updated = await tx
    .update(approvalSubmission)
    .set({
      state: "SUBMITTED",
      submittedTurnId,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(heldBy(lease))
    .returning({ id: approvalSubmission.id });

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/**
 * Release a failed submission for retry, or move it to FAILED once MAX_ATTEMPTS is
 * exhausted. Same exponential backoff formula as lib/jobs/queue.ts's fail() and
 * lib/delivery/queue.ts's fail().
 */
export async function fail(lease: ApprovalSubmissionLease, error: string): Promise<void> {
  const updated = await db.execute<{ id: string }>(sql`
    update ${approvalSubmission}
       set state = case
                     when ${approvalSubmission.attempts} >= ${MAX_ATTEMPTS}
                     then 'FAILED'
                     else 'PENDING'
                   end,
           lease_owner      = null,
           lease_expires_at = null,
           last_error       = ${error},
           next_attempt_at  = now() + make_interval(
             secs => least(power(2, ${approvalSubmission.attempts})::int, 300)
           ),
           updated_at       = now()
     where ${approvalSubmission.id}         = ${lease.id}
       and ${approvalSubmission.leaseOwner} = ${lease.leaseOwner}
       and ${approvalSubmission.fence}      = ${lease.fence}
       and ${approvalSubmission.leaseExpiresAt} > now()
    returning ${approvalSubmission.id} as id
  `);

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/** Stop retrying an invariant failure that another attempt cannot repair. */
export async function failPermanently(
  lease: ApprovalSubmissionLease,
  error: string,
  tx: Executor = db,
): Promise<void> {
  const updated = await tx
    .update(approvalSubmission)
    .set({
      state: "FAILED",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: error,
      updatedAt: new Date(),
    })
    .where(heldBy(lease))
    .returning({ id: approvalSubmission.id });

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/**
 * Reclaim retryable rows whose worker died. A row that died on its final attempt becomes
 * FAILED because claim() excludes rows at or past MAX_ATTEMPTS.
 */
export async function sweepExpiredLeases(): Promise<{
  released: number;
  failed: number;
}> {
  const failed = await db.execute<{ id: string }>(sql`
    update ${approvalSubmission}
       set state            = 'FAILED',
           lease_owner      = null,
           lease_expires_at = null,
           last_error       = coalesce(
             ${approvalSubmission.lastError},
             'approval submission worker died on the final attempt'
           ),
           updated_at       = now()
     where ${approvalSubmission.state} = 'PENDING'
       and ${approvalSubmission.leaseExpiresAt} < now()
       and ${approvalSubmission.attempts} >= ${MAX_ATTEMPTS}
    returning ${approvalSubmission.id} as id
  `);

  const released = await db
    .update(approvalSubmission)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        or(
          eq(approvalSubmission.state, "PENDING"),
          eq(approvalSubmission.state, "FAILED"),
        ),
        lte(approvalSubmission.leaseExpiresAt, new Date()),
        sql`${approvalSubmission.attempts} < ${MAX_ATTEMPTS}`,
      ),
    )
    .returning({ id: approvalSubmission.id });

  return { released: released.length, failed: failed.length };
}
