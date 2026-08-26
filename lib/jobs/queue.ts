import { and, eq, lt, or, sql } from "drizzle-orm";

import { db, inboundJob } from "@/lib/db";

export type JobExecutionState =
  (typeof inboundJob.state.enumValues)[number];

/** States a job can no longer move out of. A redelivery landing on one of these is a no-op. */
const TERMINAL: readonly JobExecutionState[] = ["DONE", "DEAD_LETTER"];

export function isTerminal(state: JobExecutionState): boolean {
  return TERMINAL.includes(state);
}

export type EnqueueInput = {
  channel: (typeof inboundJob.channel.enumValues)[number];
  deliveryId: string;
  payload: unknown;
};

export type EnqueueResult = {
  jobId: string;
  state: JobExecutionState;
  /** False when this delivery had already been recorded, i.e. the webhook was replayed. */
  created: boolean;
};

/**
 * Record a delivery exactly once. Replays collide on (channel, delivery_id) and return the
 * existing row instead of starting a second run — the caller answers 202 either way, since
 * from the sender's point of view the delivery is accepted in both cases.
 */
export async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  const inserted = await db
    .insert(inboundJob)
    .values({
      channel: input.channel,
      deliveryId: input.deliveryId,
      payload: input.payload as never,
    })
    .onConflictDoNothing({
      target: [inboundJob.channel, inboundJob.deliveryId],
    })
    .returning({ id: inboundJob.id, state: inboundJob.state });

  if (inserted.length > 0) {
    return { jobId: inserted[0].id, state: inserted[0].state, created: true };
  }

  const [existing] = await db
    .select({ id: inboundJob.id, state: inboundJob.state })
    .from(inboundJob)
    .where(
      and(
        eq(inboundJob.channel, input.channel),
        eq(inboundJob.deliveryId, input.deliveryId),
      ),
    )
    .limit(1);

  if (!existing) {
    // The conflicting row vanished between the insert and this read. Vanishingly unlikely,
    // but returning a fabricated id would be worse than saying so.
    throw new Error(
      `enqueue: conflict on (${input.channel}, ${input.deliveryId}) but no row found`,
    );
  }

  return { jobId: existing.id, state: existing.state, created: false };
}

export type ClaimedJob = {
  id: string;
  channel: (typeof inboundJob.channel.enumValues)[number];
  deliveryId: string;
  payload: unknown;
  attempts: number;
  reportId: string | null;
};

/**
 * Take exactly one job, atomically.
 *
 * FOR UPDATE SKIP LOCKED is what makes this safe with more than one worker: rows already
 * locked by another claim are stepped over rather than waited on, so two workers can never
 * hand back the same job and neither blocks the other. Postgres does the mutual exclusion;
 * there is no application-level lock to get wrong.
 *
 * A job is claimable when it is not terminal, its backoff has elapsed, and either nobody
 * holds it or the holder's lease has expired (that second case is crash recovery: a worker
 * that died mid-job leaves a lease behind, and it simply times out).
 */
export async function claim(
  owner: string,
  leaseSeconds = 60,
): Promise<ClaimedJob | null> {
  const rows = await db.execute<{
    id: string;
    channel: ClaimedJob["channel"];
    delivery_id: string;
    payload: unknown;
    attempts: number;
    report_id: string | null;
  }>(sql`
    update ${inboundJob}
       set state            = 'RUNNING',
           lease_owner      = ${owner},
           lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           attempts         = ${inboundJob.attempts} + 1,
           updated_at       = now()
     where ${inboundJob.id} = (
       select ${inboundJob.id}
         from ${inboundJob}
        where ${inboundJob.state} not in ('DONE', 'DEAD_LETTER')
          and ${inboundJob.nextAttemptAt} <= now()
          and (${inboundJob.leaseExpiresAt} is null or ${inboundJob.leaseExpiresAt} < now())
        order by ${inboundJob.nextAttemptAt}
        limit 1
        for update skip locked
     )
    returning ${inboundJob.id}          as id,
              ${inboundJob.channel}     as channel,
              ${inboundJob.deliveryId}  as delivery_id,
              ${inboundJob.payload}     as payload,
              ${inboundJob.attempts}    as attempts,
              ${inboundJob.reportId}    as report_id
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    channel: row.channel,
    deliveryId: row.delivery_id,
    payload: row.payload,
    attempts: row.attempts,
    reportId: row.report_id,
  };
}

/** Move a held job to its next state, keeping the lease. */
export async function advance(
  jobId: string,
  state: JobExecutionState,
  patch: { reportId?: string } = {},
): Promise<void> {
  await db
    .update(inboundJob)
    .set({ state, updatedAt: new Date(), ...patch })
    .where(eq(inboundJob.id, jobId));
}

/** Finish a job and drop the lease. */
export async function complete(jobId: string): Promise<void> {
  await db
    .update(inboundJob)
    .set({
      state: "DONE",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(inboundJob.id, jobId));
}

/**
 * Release a failed job for retry, or bury it once it has burned through its attempts.
 * Backoff is exponential on the attempt count so a persistently broken delivery backs off
 * instead of spinning.
 */
export async function fail(jobId: string, error: string): Promise<void> {
  await db.execute(sql`
    update ${inboundJob}
       set state = case
                     when ${inboundJob.attempts} >= ${inboundJob.maxAttempts}
                     then 'DEAD_LETTER'::job_execution_state
                     else 'RECEIVED'::job_execution_state
                   end,
           lease_owner      = null,
           lease_expires_at = null,
           last_error       = ${error},
           next_attempt_at  = now() + make_interval(
             secs => least(power(2, ${inboundJob.attempts})::int, 300)
           ),
           updated_at       = now()
     where ${inboundJob.id} = ${jobId}
  `);
}

/**
 * Free jobs whose worker died holding the lease. Claiming already ignores expired leases, so
 * this is only bookkeeping — it clears the stale owner so the queue reads honestly.
 */
export async function sweepExpiredLeases(): Promise<number> {
  const rows = await db
    .update(inboundJob)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        or(eq(inboundJob.state, "RUNNING"), eq(inboundJob.state, "SESSION_CREATED")),
        lt(inboundJob.leaseExpiresAt, new Date()),
      ),
    )
    .returning({ id: inboundJob.id });

  return rows.length;
}
