import type { Executor } from "@/lib/db";
import { and, db, eq, sql, targetProfile } from "@/lib/db";

import { sanitizeScopeState, Scope, type ScopeState } from "./scope";

/**
 * Drizzle-backed adapter between the DB-agnostic `Scope` class and
 * `target_profile.scope_rules`. Scope-guard has one live target for this demo, so which
 * profile to bind to is resolved once, not passed in on every MCP call: `SCOPE_GUARD_TARGET_PROFILE`
 * names it explicitly when more than one profile exists; otherwise the sole row is used, which
 * fails loudly rather than guessing if that stops being true.
 *
 * `target_profile.scope_rules` already holds seeded data in the shape
 * `[{ "allow": "localhost" }]` (see lib/targets/configure.ts, which this module does not
 * touch), so that array-of-rule-objects convention is kept rather than replaced with Scope's
 * internal `{ allow, temporary, updatedAt }` shape. A `{ temporary, expiresAt }` rule object
 * carries the runtime self-expiring entries scope_add_temporary creates.
 */

type RawRule = { allow: string } | { temporary: string; expiresAt: number } | Record<string, unknown>;

export function parseScopeRules(raw: unknown): { allow: unknown[]; temporary: unknown[] } {
  const rules: RawRule[] = Array.isArray(raw) ? (raw as RawRule[]) : [];
  const allow: unknown[] = [];
  const temporary: unknown[] = [];
  for (const rule of rules) {
    if (rule && typeof rule === "object" && "allow" in rule && typeof rule.allow === "string") {
      allow.push(rule.allow);
    } else if (
      rule &&
      typeof rule === "object" &&
      "temporary" in rule &&
      typeof (rule as { temporary: unknown }).temporary === "string"
    ) {
      temporary.push({ entry: (rule as { temporary: string }).temporary, expiresAt: (rule as { expiresAt: unknown }).expiresAt });
    }
  }
  return { allow, temporary };
}

export function serializeScopeState(state: ScopeState): RawRule[] {
  return [
    ...state.allow.map((entry) => ({ allow: entry })),
    ...state.temporary.map((t) => ({ temporary: t.entry, expiresAt: t.expiresAt })),
  ];
}

export interface ResolvedProfile {
  id: string;
  config: unknown;
  scopeRules: unknown;
  updatedAt: Date;
}

async function resolveProfile(executor: Executor, forUpdate: boolean): Promise<ResolvedProfile> {
  const wantedName = process.env.SCOPE_GUARD_TARGET_PROFILE?.trim();

  let query = executor
    .select({
      id: targetProfile.id,
      config: targetProfile.config,
      scopeRules: targetProfile.scopeRules,
      updatedAt: targetProfile.updatedAt,
    })
    .from(targetProfile)
    .$dynamic();
  if (wantedName) query = query.where(eq(targetProfile.name, wantedName));
  const rows = forUpdate ? await query.for("update") : await query;

  if (wantedName) {
    if (rows.length === 0) throw new Error(`SCOPE_GUARD_TARGET_PROFILE "${wantedName}" does not exist`);
    return rows[0];
  }
  if (rows.length === 0) {
    throw new Error("no target_profile row exists yet; scope-guard has nothing to bind to");
  }
  if (rows.length > 1) {
    throw new Error(
      `${rows.length} target_profile rows exist; set SCOPE_GUARD_TARGET_PROFILE to disambiguate`,
    );
  }
  return rows[0];
}

function stateFromRaw(scopeRules: unknown): ScopeState {
  // parseScopeRules always returns an array for `allow` (empty when scope_rules holds none),
  // so sanitizeScopeState always sees a present array here and never applies its own defaults -
  // an emptied or all-quarantined column stays empty rather than resurrecting localhost.
  const { allow, temporary } = parseScopeRules(scopeRules);
  const { state } = sanitizeScopeState({ allow, temporary, updatedAt: new Date().toISOString() });
  return state;
}

/**
 * Builds the persist callback a Scope writes back through. The `WHERE ... AND updatedAt =
 * <the row's updatedAt at read time>` clause is optimistic concurrency: it makes a write a
 * no-op (0 rows affected) if the row changed since `profile` was read, instead of overwriting
 * whatever landed in between. That matters most for the read-only path below, where
 * Scope.pruneTemporary() fires a write with nobody awaiting it - without this guard, a stale
 * prune triggered before a concurrent, properly-locked scope_add/scope_remove/
 * scope_add_temporary call could still land after it and erase that mutation.
 *
 * The comparison is truncated to millisecond precision on both sides rather than compared raw:
 * `updated_at` is `timestamptz`, which Postgres stores at microsecond precision, but a row
 * whose timestamp came from the column's own `default now()` (every freshly-provisioned
 * profile) carries microseconds a round trip through JS `Date` can't preserve - a raw equality
 * check would then never match and every write would look "stale" and silently no-op. Every
 * write this module makes sets `updatedAt` from JS `Date`, so collapsing both sides to
 * millisecond resolution costs nothing on the writes we control while fixing the reads we
 * don't.
 *
 * ponytail: this makes two writes racing inside the same millisecond indistinguishable from
 * each other, which a dedicated version/sequence column would not. Scope-guard has one target
 * profile, mutated only through a human-approval-gated MCP call, so that window isn't a
 * realistic concern here; revisit with a real version column if that ever stops being true.
 */
export function makePersist(executor: Executor, profile: ResolvedProfile): (state: ScopeState) => Promise<void> {
  return async (state) => {
    await executor
      .update(targetProfile)
      .set({ scopeRules: serializeScopeState(state), updatedAt: new Date() })
      .where(
        and(
          eq(targetProfile.id, profile.id),
          sql`date_trunc('milliseconds', ${targetProfile.updatedAt}) = date_trunc('milliseconds', ${profile.updatedAt.toISOString()}::timestamptz)`,
        ),
      );
  };
}

/**
 * Runs `fn` against a `Scope` loaded from the bound target profile. `mutate: true` locks the
 * profile row for the whole transaction (`SELECT ... FOR UPDATE`, the same pattern
 * lib/agent-sessions/poller.ts uses for its report row) so two concurrent scope_add/
 * scope_remove/scope_add_temporary calls cannot both read the same allowlist and each write
 * back a version missing the other's change. Read-only calls (scope_check, scope_list, ...)
 * pass `mutate: false` and run outside a transaction; a best-effort write can still happen if
 * check() prunes an expired temporary entry, guarded by the same optimistic version check
 * makePersist applies to the locked path.
 */
export async function withScope<T>(
  mutate: boolean,
  fn: (scope: Scope) => Promise<T> | T,
): Promise<T> {
  return withScopeProfile(mutate, (scope) => fn(scope));
}

export async function withScopeProfile<T>(
  mutate: boolean,
  fn: (scope: Scope, profile: ResolvedProfile) => Promise<T> | T,
): Promise<T> {
  if (!mutate) {
    const profile = await resolveProfile(db, false);
    const scope = new Scope(stateFromRaw(profile.scopeRules), undefined, makePersist(db, profile));
    return fn(scope, profile);
  }

  return db.transaction(async (tx) => {
    const profile = await resolveProfile(tx, true);
    const scope = new Scope(stateFromRaw(profile.scopeRules), undefined, makePersist(tx, profile));
    return fn(scope, profile);
  });
}
