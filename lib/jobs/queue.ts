import { and, eq, lte, or, sql } from "drizzle-orm";

import { db, inboundJob } from "@/lib/db";

export type JobExecutionState = (typeof inboundJob.state.enumValues)[number];
export type IntakeChannel = (typeof inboundJob.channel.enumValues)[number];

/** States a job can no longer move out of. A redelivery landing on one of these is a no-op. */
export const TERMINAL_STATES = ["DONE", "DEAD_LETTER"] as const;

export function isTerminal(state: JobExecutionState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * The only transitions that exist. Without this an `advance(id, "PARSED")` on a finished job
 * would quietly resurrect it, and a caller could skip straight from RECEIVED to DONE without
 * ever having done the work in between.
 *
 * Every non-terminal state can also go to DEAD_LETTER; that is added below rather than
 * repeated on each line.
 */
const ALLOWED_TRANSITIONS: Record<JobExecutionState, readonly JobExecutionState[]> = {
  RECEIVED: ["PARSED"],
  PARSED: ["SESSION_CREATED"],
  SESSION_CREATED: ["RUNNING"],
  RUNNING: ["DONE"],
  DONE: [],
  DEAD_LETTER: [],
};

export function canTransition(
  from: JobExecutionState,
  to: JobExecutionState,
): boolean {
  if (isTerminal(from)) return false;
  if (to === "DEAD_LETTER") return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export type EnqueueInput = {
  channel: IntakeChannel;
  deliveryId: string;
  payload: unknown;
};

export type EnqueueResult = {
  jobId: string;
  state: JobExecutionState;
  /** False when this delivery had already been recorded, i.e. the webhook was replayed. */
  created: boolean;
  /** Tells intake whether a replay is still active or is a terminal no-op. */
  disposition: "CREATED" | "IN_FLIGHT" | "TERMINAL_REPLAY";
};

/**
 * Record a delivery exactly once. Replays collide on (channel, delivery_id) and return the
 * existing row instead of starting a second run. The caller answers 202 either way, because
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
    return {
      jobId: inserted[0].id,
      state: inserted[0].state,
      created: true,
      disposition: "CREATED",
    };
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

  return {
    jobId: existing.id,
    state: existing.state,
    created: false,
    disposition: isTerminal(existing.state) ? "TERMINAL_REPLAY" : "IN_FLIGHT",
  };
}

/**
 * A held job. `fence` is the caller's proof of ownership: every mutating call takes this
 * lease back, and the update is scoped to it, so a worker that lost the lease writes nothing.
 */
export type Lease = {
  id: string;
  channel: IntakeChannel;
  deliveryId: string;
  payload: unknown;
  state: JobExecutionState;
  attempts: number;
  reportId: string | null;
  owner: string;
  fence: number;
};

/**
 * Take exactly one job, atomically.
 *
 * FOR UPDATE SKIP LOCKED is what makes this safe with more than one worker: rows already
 * locked by another claim are stepped over rather than waited on, so two workers can never
 * hand back the same job and neither blocks the other. Postgres does the mutual exclusion;
 * there is no application-level lock to get wrong.
 *
 * Claiming takes ownership only. It deliberately does NOT move the job's state: leasing is
 * orthogonal to the lifecycle, and stamping RUNNING here would skip PARSED and
 * SESSION_CREATED, making the recorded state a lie about what had actually happened.
 *
 * A job is claimable when it is not terminal, has attempts left, its backoff has elapsed, and
 * either nobody holds it or the holder's lease has expired. That last case is crash recovery:
 * a worker that died mid-job leaves a lease behind, and it simply times out.
 */
export async function claim(
  owner: string,
  leaseSeconds = 60,
): Promise<Lease | null> {
  const rows = await db.execute<{
    id: string;
    channel: IntakeChannel;
    delivery_id: string;
    payload: unknown;
    state: JobExecutionState;
    attempts: number;
    report_id: string | null;
    fence: string | number;
  }>(sql`
    update ${inboundJob}
       set lease_owner      = ${owner},
           lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           attempts         = ${inboundJob.attempts} + 1,
           fence            = ${inboundJob.fence} + 1,
           updated_at       = now()
     where ${inboundJob.id} = (
       select ${inboundJob.id}
         from ${inboundJob}
        where ${inboundJob.state} not in ('DONE', 'DEAD_LETTER')
          and ${inboundJob.attempts} < ${inboundJob.maxAttempts}
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
              ${inboundJob.state}       as state,
              ${inboundJob.attempts}    as attempts,
              ${inboundJob.reportId}    as report_id,
              ${inboundJob.fence}       as fence
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    channel: row.channel,
    deliveryId: row.delivery_id,
    payload: row.payload,
    state: row.state,
    attempts: row.attempts,
    reportId: row.report_id,
    owner,
    fence: Number(row.fence),
  };
}

/** Raised when a mutation is attempted with a lease that is no longer the current one. */
export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(
      `lease on job ${jobId} is no longer held by this worker; another worker has taken over`,
    );
    this.name = "LeaseLostError";
  }
}

/** Scopes an update to the exact lease the caller holds. */
function heldBy(lease: Lease) {
  return and(
    eq(inboundJob.id, lease.id),
    eq(inboundJob.leaseOwner, lease.owner),
    eq(inboundJob.fence, lease.fence),
    sql`${inboundJob.leaseExpiresAt} > now()`,
  );
}

/**
 * Move a held job to its next state, keeping the lease.
 *
 * Refuses transitions that are not in the graph, and writes only while the caller still holds
 * the lease it was issued. Returns the lease so the caller carries the new state forward.
 */
export async function advance(
  lease: Lease,
  to: JobExecutionState,
  patch: { reportId?: string } = {},
): Promise<Lease> {
  if (!canTransition(lease.state, to)) {
    throw new Error(
      `illegal job transition ${lease.state} -> ${to} for job ${lease.id}`,
    );
  }

  const updated = await db
    .update(inboundJob)
    .set({ state: to, updatedAt: new Date(), ...patch })
    .where(and(heldBy(lease), eq(inboundJob.state, lease.state)))
    .returning({ id: inboundJob.id });

  if (updated.length === 0) throw new LeaseLostError(lease.id);

  return { ...lease, state: to, ...patch };
}

/** Finish a job and drop the lease. Only the current lease holder may do this. */
export async function complete(lease: Lease): Promise<void> {
  if (!canTransition(lease.state, "DONE")) {
    throw new Error(
      `illegal job transition ${lease.state} -> DONE for job ${lease.id}`,
    );
  }

  const updated = await db
    .update(inboundJob)
    .set({
      state: "DONE",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(heldBy(lease), eq(inboundJob.state, lease.state)))
    .returning({ id: inboundJob.id });

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/**
 * Release a failed job for retry, or bury it once it has burned through its attempts.
 *
 * The state is left where it was so the next attempt resumes from the step that failed rather
 * than redoing the ones that succeeded. Backoff is exponential on the attempt count, capped,
 * so a persistently broken delivery backs off instead of spinning.
 */
export async function fail(lease: Lease, error: string): Promise<void> {
  const updated = await db.execute<{ id: string }>(sql`
    update ${inboundJob}
       set state = case
                     when ${inboundJob.attempts} >= ${inboundJob.maxAttempts}
                     then 'DEAD_LETTER'::job_execution_state
                     else ${inboundJob.state}
                   end,
           lease_owner      = null,
           lease_expires_at = null,
           last_error       = ${error},
           next_attempt_at  = now() + make_interval(
             secs => least(power(2, ${inboundJob.attempts})::int, 300)
           ),
           updated_at       = now()
     where ${inboundJob.id}         = ${lease.id}
       and ${inboundJob.leaseOwner} = ${lease.owner}
       and ${inboundJob.fence}      = ${lease.fence}
       and ${inboundJob.leaseExpiresAt} > now()
    returning ${inboundJob.id} as id
  `);

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/**
 * Reap jobs whose worker died holding the lease.
 *
 * Two cases. A job with attempts left just has its stale lease cleared so it can be picked up
 * again. A job that died on its final attempt is buried: claim() skips exhausted jobs, so
 * without this it would sit non-terminal forever, invisible to both the queue and the
 * dead-letter view.
 */
export async function sweepExpiredLeases(): Promise<{
  released: number;
  deadLettered: number;
}> {
  const buried = await db.execute<{ id: string }>(sql`
    update ${inboundJob}
       set state            = 'DEAD_LETTER',
           lease_owner      = null,
           lease_expires_at = null,
           last_error       = coalesce(${inboundJob.lastError}, 'worker died on the final attempt'),
           updated_at       = now()
     where ${inboundJob.state} not in ('DONE', 'DEAD_LETTER')
       and ${inboundJob.leaseExpiresAt} < now()
       and ${inboundJob.attempts} >= ${inboundJob.maxAttempts}
    returning ${inboundJob.id} as id
  `);

  const released = await db
    .update(inboundJob)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        or(
          eq(inboundJob.state, "RECEIVED"),
          eq(inboundJob.state, "PARSED"),
          eq(inboundJob.state, "SESSION_CREATED"),
          eq(inboundJob.state, "RUNNING"),
        ),
        lte(inboundJob.leaseExpiresAt, new Date()),
      ),
    )
    .returning({ id: inboundJob.id });

  return { released: released.length, deadLettered: buried.length };
}
