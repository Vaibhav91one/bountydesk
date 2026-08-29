import { randomUUID } from "node:crypto";

import { and, db, eq, scopeGuardGrant, type Executor } from "@/lib/db";

/**
 * Single-use consent tokens backing `request_intrusive_approval` / `verify_grant`, ported from
 * Sentinel's in-memory `Map<string, Grant>` (see mcp/scope-guard/src/index.ts) into a Postgres
 * table so a grant survives a restart and, more importantly, so "single-use" is something the
 * database enforces rather than something one process's memory happens to remember.
 *
 * A grant is two rows sharing a token, never one row mutated in place: `mint()` inserts an
 * `issued` row, `verify()` inserts a matching `consumed` row. This keeps `scope_guard_grant`
 * genuinely insert-only (the same trigger that guards verdict/approval_decision applies here
 * too), while still making double-spend impossible: `verify()` takes a `SELECT ... FOR UPDATE`
 * on the issued row before checking for and inserting the consumed one, so two callers racing
 * the same token serialize on that lock rather than both seeing "not yet consumed" (see
 * grants.test.ts for the concurrency proof, same style as audit.test.ts's chain proof).
 */

export interface MintedGrant {
  token: string;
  target: string;
  action: string;
  expiresAt: Date;
}

export type VerifyResult = { valid: boolean; reason: string };

const GRANT_TTL_MINUTES = 10;

/** Issues a fresh single-use grant. Only call this after the harness's own human-approval gate
 * has already returned "approved" for this call - minting is bookkeeping for a decision made
 * elsewhere, never the decision itself. */
export async function mint(
  target: string,
  action: string,
  executor: Executor = db,
  ttlMinutes: number = GRANT_TTL_MINUTES,
): Promise<MintedGrant> {
  const token = randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  await executor.insert(scopeGuardGrant).values({
    token,
    target,
    action,
    event: "issued",
    expiresAt,
  });
  return { token, target, action, expiresAt };
}

/**
 * Consumes a single-use grant token for a target. Returns `valid: false` on an unknown token,
 * expiry, target mismatch, or reuse; only a genuine first use for the exact (token, target)
 * pair returns `valid: true`.
 *
 * A wrong-target attempt does not burn the grant: a typo by the already-approved caller
 * should not force a fresh human approval. Only a matching pair consumes it, mirroring
 * Sentinel's original behavior.
 */
export async function verify(token: string, target: string, outerExecutor: Executor = db): Promise<VerifyResult> {
  const run = async (tx: Executor): Promise<VerifyResult> => {
    const [issued] = await tx
      .select()
      .from(scopeGuardGrant)
      .where(and(eq(scopeGuardGrant.token, token), eq(scopeGuardGrant.event, "issued")))
      .limit(1)
      .for("update");

    if (!issued) return { valid: false, reason: "unknown grant token" };

    if (!issued.expiresAt || issued.expiresAt.getTime() <= Date.now()) {
      return { valid: false, reason: "grant expired" };
    }

    if (issued.target !== target) {
      return {
        valid: false,
        reason: `grant was issued for ${issued.target}, not ${target} (grant remains active)`,
      };
    }

    // Still inside the lock on the issued row: a second transaction verifying the same token
    // blocks here until this one commits or rolls back, so this check-then-insert cannot race.
    const [alreadyConsumed] = await tx
      .select({ id: scopeGuardGrant.id })
      .from(scopeGuardGrant)
      .where(and(eq(scopeGuardGrant.token, token), eq(scopeGuardGrant.event, "consumed")))
      .limit(1);

    if (alreadyConsumed) return { valid: false, reason: "grant already used" };

    await tx.insert(scopeGuardGrant).values({
      token,
      target: issued.target,
      action: issued.action,
      event: "consumed",
      expiresAt: null,
    });

    return { valid: true, reason: `human-approved grant for "${issued.action}" on ${issued.target}` };
  };

  return outerExecutor === db ? db.transaction((tx) => run(tx)) : run(outerExecutor);
}

// No pruning function: scope_guard_grant is insert-only (the same trigger that guards
// verdict/approval_decision applies to it), so an expired row cannot be deleted any more than
// a used one can be reset. verify() already refuses an expired grant on its own; the row is
// just kept around, same as every other evidence table in this schema.
