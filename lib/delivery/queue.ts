import { and, eq, lte, sql } from "drizzle-orm";

import { db, outboundDelivery, type Executor } from "@/lib/db";

export type DeliveryState = (typeof outboundDelivery.state.enumValues)[number];

/**
 * A held outbox row. Carries everything the delivery worker needs (verdict id, the approved
 * hash to check against, the GitHub target) so it never has to re-query the row it just
 * claimed. Mirrors `lib/jobs/queue.ts`'s `Lease`, but there is no `payload` here: the outbox
 * never stores the comment body, only a hash to verify it against `verdict.payload`.
 */
export type DeliveryLease = {
  id: string;
  reportId: string;
  verdictId: string;
  idempotencyKey: string;
  target: string;
  approvedContentHash: string;
  attempts: number;
  maxAttempts: number;
  fence: number;
  leaseOwner: string;
};

/**
 * Take exactly one deliverable row, atomically. Same FOR UPDATE SKIP LOCKED shape as
 * `lib/jobs/queue.ts`'s `claim`: two drainer workers never fight over a lock and never hand
 * back the same row.
 *
 * Claimable means PENDING, attempts remaining, backoff elapsed, and either unheld or the
 * prior holder's lease expired (a worker that crashed mid-send).
 */
export async function claim(
  owner: string,
  leaseSeconds = 60,
): Promise<DeliveryLease | null> {
  const rows = await db.execute<{
    id: string;
    report_id: string;
    verdict_id: string;
    idempotency_key: string;
    target: string;
    approved_content_hash: string;
    attempts: number;
    max_attempts: number;
    fence: string | number;
  }>(sql`
    update ${outboundDelivery}
       set lease_owner      = ${owner},
           lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           attempts         = ${outboundDelivery.attempts} + 1,
           fence            = ${outboundDelivery.fence} + 1,
           updated_at       = now()
     where ${outboundDelivery.id} = (
       select ${outboundDelivery.id}
         from ${outboundDelivery}
        where ${outboundDelivery.state} = 'PENDING'
          and ${outboundDelivery.attempts} < ${outboundDelivery.maxAttempts}
          and ${outboundDelivery.nextAttemptAt} <= now()
          and (${outboundDelivery.leaseExpiresAt} is null or ${outboundDelivery.leaseExpiresAt} < now())
        order by ${outboundDelivery.nextAttemptAt}
        limit 1
        for update skip locked
     )
    returning ${outboundDelivery.id}                  as id,
              ${outboundDelivery.reportId}             as report_id,
              ${outboundDelivery.verdictId}             as verdict_id,
              ${outboundDelivery.idempotencyKey}        as idempotency_key,
              ${outboundDelivery.target}                as target,
              ${outboundDelivery.approvedContentHash}   as approved_content_hash,
              ${outboundDelivery.attempts}               as attempts,
              ${outboundDelivery.maxAttempts}            as max_attempts,
              ${outboundDelivery.fence}                  as fence
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    reportId: row.report_id,
    verdictId: row.verdict_id,
    idempotencyKey: row.idempotency_key,
    target: row.target,
    approvedContentHash: row.approved_content_hash,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    fence: Number(row.fence),
    leaseOwner: owner,
  };
}

/** Raised when a mutation is attempted with a lease that is no longer the current one. */
export class LeaseLostError extends Error {
  constructor(deliveryId: string) {
    super(
      `lease on delivery ${deliveryId} is no longer held by this worker; another worker has taken over`,
    );
    this.name = "LeaseLostError";
  }
}

/** Scopes an update to the exact lease the caller holds. */
function heldBy(lease: DeliveryLease) {
  return and(
    eq(outboundDelivery.id, lease.id),
    eq(outboundDelivery.leaseOwner, lease.leaseOwner),
    eq(outboundDelivery.fence, lease.fence),
    sql`${outboundDelivery.leaseExpiresAt} > now()`,
  );
}

/** Extend a held lease without changing its owner or fence. */
export async function renew(lease: DeliveryLease, leaseSeconds: number): Promise<void> {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error("leaseSeconds must be greater than zero");
  }

  const updated = await db
    .update(outboundDelivery)
    .set({
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
      updatedAt: new Date(),
    })
    .where(heldBy(lease))
    .returning({ id: outboundDelivery.id });

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/** Mark a delivery sent and drop the lease. Accepts a transaction so the caller can commit
 * this alongside the report's DELIVERING -> DELIVERED move as one unit. */
export async function markSent(lease: DeliveryLease, tx: Executor = db): Promise<void> {
  const updated = await tx
    .update(outboundDelivery)
    .set({
      state: "SENT",
      deliveredAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(heldBy(lease))
    .returning({ id: outboundDelivery.id });

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/**
 * Release a failed delivery for retry, or move it to FAILED once attempts are exhausted.
 * Same exponential backoff formula as `lib/jobs/queue.ts`'s `fail`, for a transient error
 * that a retry might clear (a network blip, a 5xx from GitHub).
 */
export async function fail(lease: DeliveryLease, error: string): Promise<void> {
  const updated = await db.execute<{ id: string }>(sql`
    update ${outboundDelivery}
       set state = case
                     when ${outboundDelivery.attempts} >= ${outboundDelivery.maxAttempts}
                     then 'FAILED'::delivery_state
                     else 'PENDING'::delivery_state
                   end,
           lease_owner      = null,
           lease_expires_at = null,
           last_error       = ${error},
           next_attempt_at  = now() + make_interval(
             secs => least(power(2, ${outboundDelivery.attempts})::int, 300)
           ),
           updated_at       = now()
     where ${outboundDelivery.id}         = ${lease.id}
       and ${outboundDelivery.leaseOwner} = ${lease.leaseOwner}
       and ${outboundDelivery.fence}      = ${lease.fence}
       and ${outboundDelivery.leaseExpiresAt} > now()
    returning ${outboundDelivery.id} as id
  `);

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/**
 * Move straight to FAILED, no matter how many attempts remain. For a refusal that a retry
 * cannot fix: a content-hash mismatch is stored corruption, and a suspended installation or
 * removed repository needs an operator, not five more identical tries.
 */
export async function failPermanently(lease: DeliveryLease, error: string): Promise<void> {
  const updated = await db
    .update(outboundDelivery)
    .set({
      state: "FAILED",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: error,
      updatedAt: new Date(),
    })
    .where(heldBy(lease))
    .returning({ id: outboundDelivery.id });

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/**
 * Reclaim rows whose worker died holding the lease, same idea as
 * `lib/jobs/queue.ts`'s `sweepExpiredLeases`: clearing the lease is enough, `claim`'s own
 * filters (state, attempts, backoff) decide whether the row is claimable again.
 */
export async function sweepExpiredLeases(): Promise<{ released: number }> {
  const released = await db
    .update(outboundDelivery)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(outboundDelivery.state, "PENDING"), lte(outboundDelivery.leaseExpiresAt, new Date())))
    .returning({ id: outboundDelivery.id });

  return { released: released.length };
}
