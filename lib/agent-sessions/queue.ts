import { and, eq, lte, sql } from "drizzle-orm";

import { agentSession, db, type Executor } from "@/lib/db";

/**
 * Local bookkeeping only, never a report state (see lib/db/schema.ts on agentSession).
 * RUNNING is set once, by the driver, the instant a turn is created and the agent hasn't
 * called anything yet; INVESTIGATING is what the poller promotes it to once it has actually
 * observed that same turn still going on a later poll, meaning the agent is genuinely mid
 * investigation rather than just starting. AWAITING_APPROVAL_HARNESS means TrueForge is
 * holding a pending publish_verdict call, not that the report has moved: the poller is what
 * moves the report, once, when it first sees that pending call (see poller.ts).
 */
export type TurnStatus =
  | "RUNNING"
  | "INVESTIGATING"
  | "AWAITING_APPROVAL_HARNESS"
  | "DONE_NO_ACTION"
  | "ERROR"
  | "CANCELLED";

const TERMINAL_TURN_STATUSES = ["DONE_NO_ACTION", "ERROR", "CANCELLED"] as const;

export function isTerminal(status: string): boolean {
  return (TERMINAL_TURN_STATUSES as readonly string[]).includes(status);
}

/**
 * A held agent_session row. Carries everything the poller needs (the pending markers, the
 * capability token to verify against) so it never has to re-query the row it just claimed.
 * Mirrors lib/jobs/queue.ts's Lease and lib/delivery/queue.ts's DeliveryLease.
 */
export type AgentSessionLease = {
  id: string;
  reportId: string;
  capabilityToken: string;
  sessionId: string;
  turnId: string | null;
  turnStatus: string;
  pendingThreadId: string | null;
  pendingToolCallId: string | null;
  pendingVerdictId: string | null;
  pendingApprovedContentHash: string | null;
  /** The Daytona sandbox lib/analysis/trueforge-driver.ts provisioned for this session, if
   * any -- carried on the lease so the poller's terminal paths (lib/agent-sessions/poller.ts)
   * can tear it down without a second query. */
  sandboxId: string | null;
  lastMirroredEventId: string | null;
  /** The agent's closing summary, once captured. Carried so a poll can tell whether it still
   * needs to fetch one (see lib/agent-sessions/poller.ts). */
  finalSummary: string | null;
  fence: number;
  leaseOwner: string;
};

/** Raised when a mutation is attempted with a lease that is no longer the current one. */
export class LeaseLostError extends Error {
  constructor(agentSessionId: string) {
    super(
      `lease on agent session ${agentSessionId} is no longer held by this worker; another worker has taken over`,
    );
    this.name = "LeaseLostError";
  }
}

/**
 * Take exactly one pollable agent_session row, atomically. Same FOR UPDATE SKIP LOCKED shape
 * as lib/jobs/queue.ts's claim: two pollers never fight over a lock and never hand back the
 * same row.
 *
 * Claimable means the turn is still open (turnStatus not terminal), its poll backoff has
 * elapsed, and either nobody holds the lease or the holder's lease expired (a poller that
 * crashed mid-poll).
 */
export async function claim(
  owner: string,
  leaseSeconds = 60,
): Promise<AgentSessionLease | null> {
  const rows = await db.execute<{
    id: string;
    report_id: string;
    capability_token: string;
    session_id: string;
    turn_id: string | null;
    turn_status: string;
    pending_thread_id: string | null;
    pending_tool_call_id: string | null;
    pending_verdict_id: string | null;
    pending_approved_content_hash: string | null;
    sandbox_id: string | null;
    last_mirrored_event_id: string | null;
    final_summary: string | null;
    fence: string | number;
  }>(sql`
    update ${agentSession}
       set lease_owner      = ${owner},
           lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           attempts         = ${agentSession.attempts} + 1,
           fence            = ${agentSession.fence} + 1,
           updated_at       = now()
     where ${agentSession.id} = (
       select ${agentSession.id}
         from ${agentSession}
        where ${agentSession.turnStatus} not in ('DONE_NO_ACTION', 'ERROR', 'CANCELLED')
          and ${agentSession.nextPollAt} <= now()
          and (${agentSession.leaseExpiresAt} is null or ${agentSession.leaseExpiresAt} < now())
        order by ${agentSession.nextPollAt}
        limit 1
        for update skip locked
     )
    returning ${agentSession.id}                         as id,
              ${agentSession.reportId}                    as report_id,
              ${agentSession.capabilityToken}              as capability_token,
              ${agentSession.sessionId}                    as session_id,
              ${agentSession.turnId}                       as turn_id,
              ${agentSession.turnStatus}                   as turn_status,
              ${agentSession.pendingThreadId}               as pending_thread_id,
              ${agentSession.pendingToolCallId}             as pending_tool_call_id,
              ${agentSession.pendingVerdictId}              as pending_verdict_id,
              ${agentSession.pendingApprovedContentHash}    as pending_approved_content_hash,
              ${agentSession.sandboxId}                     as sandbox_id,
              ${agentSession.lastMirroredEventId}           as last_mirrored_event_id,
              ${agentSession.finalSummary}                  as final_summary,
              ${agentSession.fence}                         as fence
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    reportId: row.report_id,
    capabilityToken: row.capability_token,
    sessionId: row.session_id,
    turnId: row.turn_id,
    turnStatus: row.turn_status,
    pendingThreadId: row.pending_thread_id,
    pendingToolCallId: row.pending_tool_call_id,
    pendingVerdictId: row.pending_verdict_id,
    pendingApprovedContentHash: row.pending_approved_content_hash,
    sandboxId: row.sandbox_id,
    lastMirroredEventId: row.last_mirrored_event_id,
    finalSummary: row.final_summary,
    fence: Number(row.fence),
    leaseOwner: owner,
  };
}

/** Scopes an update to the exact lease the caller holds. */
function heldBy(lease: AgentSessionLease) {
  return and(
    eq(agentSession.id, lease.id),
    eq(agentSession.leaseOwner, lease.leaseOwner),
    eq(agentSession.fence, lease.fence),
    sql`${agentSession.leaseExpiresAt} > now()`,
  );
}

/** Extend a held lease without changing its owner or fence. */
export async function renew(lease: AgentSessionLease, leaseSeconds: number): Promise<void> {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error("leaseSeconds must be greater than zero");
  }

  const updated = await db
    .update(agentSession)
    .set({
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
      updatedAt: new Date(),
    })
    .where(heldBy(lease))
    .returning({ id: agentSession.id });

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/**
 * Advance the turn-event mirroring cursor without touching the lease itself. A separate call
 * from `release()` on purpose: it runs right after mirroring, while the poll is still deciding
 * what the turn's status means, so a mirroring failure never has to unwind a lease release that
 * already happened, and a release later in the same poll still finds an active lease to fence
 * against.
 */
export async function markMirrored(
  lease: AgentSessionLease,
  lastMirroredEventId: string,
): Promise<void> {
  const updated = await db
    .update(agentSession)
    .set({ lastMirroredEventId, updatedAt: new Date() })
    .where(heldBy(lease))
    .returning({ id: agentSession.id });

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/**
 * Persist the agent's captured closing summary. A separate fenced call from `release()`, like
 * `markMirrored`: it runs mid-poll while the poll is still deciding what the turn's status
 * means, and a later release in the same poll still fences against the lease this held.
 */
export async function recordFinalSummary(
  lease: AgentSessionLease,
  finalSummary: string,
): Promise<void> {
  const updated = await db
    .update(agentSession)
    .set({ finalSummary, updatedAt: new Date() })
    .where(heldBy(lease))
    .returning({ id: agentSession.id });

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

export type AgentSessionReleaseUpdate = {
  turnStatus?: TurnStatus;
  pendingThreadId?: string | null;
  pendingToolCallId?: string | null;
  pendingVerdictId?: string | null;
  pendingApprovedContentHash?: string | null;
  lastMirroredEventId?: string | null;
  nextPollAt?: Date;
  lastError?: string | null;
};

/**
 * A generic fenced update: the poller calls this after every poll attempt, regardless of
 * what it found, to write whatever subset of columns that attempt produced and drop the
 * lease. Keys the caller omits are left untouched; a key set to null explicitly clears it
 * (used to write or clear the pending_* columns together).
 */
export async function release(
  lease: AgentSessionLease,
  updates: AgentSessionReleaseUpdate,
  tx: Executor = db,
): Promise<void> {
  const patch = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  );

  const updated = await tx
    .update(agentSession)
    .set({
      ...patch,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(heldBy(lease))
    .returning({ id: agentSession.id });

  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/**
 * Reap agent_session rows whose poller died holding the lease. There is no attempt budget
 * here, unlike lib/jobs/queue.ts: a turn stays pollable indefinitely until TrueForge itself
 * resolves it (running -> done/error/cancelled/awaiting_approval), so the only thing to
 * clean up is a stale lease_owner/lease_expires_at, not a burial state.
 */
export async function sweepExpiredLeases(): Promise<{ released: number }> {
  const released = await db
    .update(agentSession)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        sql`${agentSession.turnStatus} not in ('DONE_NO_ACTION', 'ERROR', 'CANCELLED')`,
        lte(agentSession.leaseExpiresAt, new Date()),
      ),
    )
    .returning({ id: agentSession.id });

  return { released: released.length };
}
