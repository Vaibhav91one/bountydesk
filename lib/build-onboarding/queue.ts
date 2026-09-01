import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { targetOnboarding, db, type Executor } from "@/lib/db";

/**
 * The build-onboarding lease/claim engine, the same shape as lib/approval-submission/queue.ts
 * and lib/jobs/queue.ts: one claimable row taken atomically with FOR UPDATE SKIP LOCKED, a
 * fenced held-lease so a lost lease writes nothing, exponential backoff on failure, and a
 * sweeper for a worker that died holding a lease.
 *
 * What is different from the other queues is the state machine. A single row moves through
 * several worker-driven states and one human-gated one:
 *
 *   PENDING_BUILD    build the image, register the snapshot
 *   PENDING_MANIFEST run the onboarding agent, capture a validated manifest
 *   AWAITING_APPROVAL wait for a reviewer  (NOT claimable)
 *   APPROVED         verify offline, write the TargetProfile, bind the repo
 *   CONFIGURED       done  (NOT claimable)
 *   FAILED           a step exhausted its attempts
 *
 * The worker claims only the states it may advance on its own. AWAITING_APPROVAL and CONFIGURED
 * are excluded from claim() so nothing crosses a proposed manifest into a real TargetProfile
 * without a human moving it to APPROVED (see lib/build-onboarding/approve-request.ts).
 */
export const MAX_ATTEMPTS = 8;

export type OnboardingState =
  | "PENDING_BUILD"
  | "PENDING_MANIFEST"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "CONFIGURED"
  | "FAILED";

/** The states the worker may pick up. The two it may not are the human gate and the terminal. */
const CLAIMABLE: OnboardingState[] = ["PENDING_BUILD", "PENDING_MANIFEST", "APPROVED", "FAILED"];

/** A held target_onboarding row, carrying what the worker needs to resume from its state. */
export type OnboardingLease = {
  id: string;
  repoId: number;
  repoFullName: string;
  sourceRef: string;
  state: OnboardingState;
  imageName: string | null;
  imageDigest: string | null;
  snapshotId: string | null;
  buildMarker: string | null;
  dockerfileText: string | null;
  proposedManifest: unknown;
  attempts: number;
  fence: number;
  leaseOwner: string;
};

/** The columns a build step or the manifest step writes back with advance(). */
export type OnboardingAdvanceFields = Partial<{
  imageName: string;
  imageDigest: string;
  snapshotId: string;
  buildMarker: string;
  dockerfileText: string;
  proposedManifest: unknown;
}>;

export class LeaseLostError extends Error {
  constructor(onboardingId: string) {
    super(
      `lease on target onboarding ${onboardingId} is no longer held by this worker; another worker has taken over`,
    );
    this.name = "LeaseLostError";
  }
}

export type EnqueueInput = { repoId: number; repoFullName: string; sourceRef: string };

/**
 * Insert an onboarding row for a repo, idempotently. The unique index on repo_id makes a second
 * enqueue for the same repo a no-op, so a redelivered connect webhook (or a re-run script) never
 * doubles the work. Takes an optional tx so the GitHub trigger can enqueue inside the same
 * transaction that granted the repository (lib/github/lifecycle.ts).
 */
export async function enqueue(input: EnqueueInput, tx: Executor = db): Promise<void> {
  await tx
    .insert(targetOnboarding)
    .values({
      repoId: input.repoId,
      repoFullName: input.repoFullName,
      sourceRef: input.sourceRef,
    })
    .onConflictDoNothing({ target: targetOnboarding.repoId });
}

/** Take exactly one claimable row, atomically. Same shape as approval_submission's claim. */
export async function claim(owner: string, leaseSeconds = 60): Promise<OnboardingLease | null> {
  const claimable = sql.join(
    CLAIMABLE.map((state) => sql`${state}`),
    sql`, `,
  );

  const rows = await db.execute<{
    id: string;
    repo_id: string | number;
    repo_full_name: string;
    source_ref: string;
    state: OnboardingState;
    image_name: string | null;
    image_digest: string | null;
    snapshot_id: string | null;
    build_marker: string | null;
    dockerfile_text: string | null;
    proposed_manifest: unknown;
    attempts: number;
    fence: string | number;
  }>(sql`
    update ${targetOnboarding}
       set lease_owner      = ${owner},
           lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           attempts         = ${targetOnboarding.attempts} + 1,
           fence            = ${targetOnboarding.fence} + 1,
           updated_at       = now()
     where ${targetOnboarding.id} = (
       select ${targetOnboarding.id}
         from ${targetOnboarding}
        where ${targetOnboarding.state} in (${claimable})
          and ${targetOnboarding.attempts} < ${MAX_ATTEMPTS}
          and ${targetOnboarding.nextAttemptAt} <= now()
          and (${targetOnboarding.leaseExpiresAt} is null or ${targetOnboarding.leaseExpiresAt} < now())
        order by ${targetOnboarding.nextAttemptAt}
        limit 1
        for update skip locked
     )
    returning ${targetOnboarding.id}               as id,
              ${targetOnboarding.repoId}           as repo_id,
              ${targetOnboarding.repoFullName}     as repo_full_name,
              ${targetOnboarding.sourceRef}        as source_ref,
              ${targetOnboarding.state}            as state,
              ${targetOnboarding.imageName}        as image_name,
              ${targetOnboarding.imageDigest}      as image_digest,
              ${targetOnboarding.snapshotId}       as snapshot_id,
              ${targetOnboarding.buildMarker}      as build_marker,
              ${targetOnboarding.dockerfileText}   as dockerfile_text,
              ${targetOnboarding.proposedManifest} as proposed_manifest,
              ${targetOnboarding.attempts}         as attempts,
              ${targetOnboarding.fence}            as fence
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    repoId: Number(row.repo_id),
    repoFullName: row.repo_full_name,
    sourceRef: row.source_ref,
    state: row.state,
    imageName: row.image_name,
    imageDigest: row.image_digest,
    snapshotId: row.snapshot_id,
    buildMarker: row.build_marker,
    dockerfileText: row.dockerfile_text,
    proposedManifest: row.proposed_manifest,
    attempts: row.attempts,
    fence: Number(row.fence),
    leaseOwner: owner,
  };
}

/** Scopes an update to the exact lease the caller holds. */
function heldBy(lease: OnboardingLease) {
  return and(
    eq(targetOnboarding.id, lease.id),
    eq(targetOnboarding.leaseOwner, lease.leaseOwner),
    eq(targetOnboarding.fence, lease.fence),
    sql`${targetOnboarding.leaseExpiresAt} > now()`,
  );
}

/** Extend a held lease without changing its owner or fence. */
export async function renew(lease: OnboardingLease, leaseSeconds: number): Promise<void> {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error("leaseSeconds must be greater than zero");
  }
  const updated = await db
    .update(targetOnboarding)
    .set({
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
      updatedAt: new Date(),
    })
    .where(heldBy(lease))
    .returning({ id: targetOnboarding.id });
  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/**
 * Move the row to its next state, writing whatever columns that step produced, and drop the
 * lease. One UPDATE scoped to the held lease: a worker that lost its lease writes nothing.
 */
export async function advance(
  lease: OnboardingLease,
  toState: OnboardingState,
  fields: OnboardingAdvanceFields = {},
): Promise<void> {
  const updated = await db
    .update(targetOnboarding)
    .set({
      state: toState,
      ...fields,
      // Each step gets its own attempt budget: a step that succeeded should not carry its claim
      // count into the next, and the next step is claimable immediately.
      attempts: 0,
      nextAttemptAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(heldBy(lease))
    .returning({ id: targetOnboarding.id });
  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/**
 * Release a failed step for retry, or move it to FAILED once MAX_ATTEMPTS is exhausted. Same
 * exponential backoff as the other queues' fail().
 */
export async function fail(lease: OnboardingLease, error: string): Promise<void> {
  const updated = await db.execute<{ id: string }>(sql`
    update ${targetOnboarding}
       set state = case
                     when ${targetOnboarding.attempts} >= ${MAX_ATTEMPTS}
                     then 'FAILED'
                     else ${lease.state}
                   end,
           lease_owner      = null,
           lease_expires_at = null,
           last_error       = ${error},
           next_attempt_at  = now() + make_interval(
             secs => least(power(2, ${targetOnboarding.attempts})::int, 300)
           ),
           updated_at       = now()
     where ${targetOnboarding.id}         = ${lease.id}
       and ${targetOnboarding.leaseOwner} = ${lease.leaseOwner}
       and ${targetOnboarding.fence}      = ${lease.fence}
       and ${targetOnboarding.leaseExpiresAt} > now()
    returning ${targetOnboarding.id} as id
  `);
  if (updated.length === 0) throw new LeaseLostError(lease.id);
}

/**
 * Reclaim retryable rows whose worker died holding the lease. A row that died on its final
 * attempt becomes FAILED, since claim() excludes rows at or past MAX_ATTEMPTS. Terminal and the
 * human-gated AWAITING_APPROVAL are never touched: their lease is already null.
 */
export async function sweepExpiredLeases(): Promise<{ released: number; failed: number }> {
  const failed = await db.execute<{ id: string }>(sql`
    update ${targetOnboarding}
       set state            = 'FAILED',
           lease_owner      = null,
           lease_expires_at = null,
           last_error       = coalesce(
             ${targetOnboarding.lastError},
             'build-onboarding worker died on the final attempt'
           ),
           updated_at       = now()
     where ${targetOnboarding.state} in ('PENDING_BUILD', 'PENDING_MANIFEST', 'APPROVED')
       and ${targetOnboarding.leaseExpiresAt} < now()
       and ${targetOnboarding.attempts} >= ${MAX_ATTEMPTS}
    returning ${targetOnboarding.id} as id
  `);

  const released = await db
    .update(targetOnboarding)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        inArray(targetOnboarding.state, CLAIMABLE),
        lte(targetOnboarding.leaseExpiresAt, new Date()),
        sql`${targetOnboarding.attempts} < ${MAX_ATTEMPTS}`,
      ),
    )
    .returning({ id: targetOnboarding.id });

  return { released: released.length, failed: failed.length };
}
