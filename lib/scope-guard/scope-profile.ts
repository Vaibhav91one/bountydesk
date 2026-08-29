import type { Executor } from "@/lib/db";
import { db, eq, targetProfile } from "@/lib/db";

import { defaultScopeState, sanitizeScopeState, Scope, type ScopeState } from "./scope";

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

interface ResolvedProfile {
  id: string;
  scopeRules: unknown;
}

async function resolveProfile(executor: Executor, forUpdate: boolean): Promise<ResolvedProfile> {
  const wantedName = process.env.SCOPE_GUARD_TARGET_PROFILE?.trim();

  let query = executor
    .select({ id: targetProfile.id, scopeRules: targetProfile.scopeRules })
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
  const { allow, temporary } = parseScopeRules(scopeRules);
  const { state } = sanitizeScopeState({ allow, temporary, updatedAt: new Date().toISOString() });
  return state.allow.length > 0 || state.temporary.length > 0 ? state : defaultScopeState();
}

/**
 * Runs `fn` against a `Scope` loaded from the bound target profile. `mutate: true` locks the
 * profile row for the whole transaction (`SELECT ... FOR UPDATE`, the same pattern
 * lib/agent-sessions/poller.ts uses for its report row) so two concurrent scope_add/
 * scope_remove/scope_add_temporary calls cannot both read the same allowlist and each write
 * back a version missing the other's change. Read-only calls (scope_check, scope_list, ...)
 * pass `mutate: false` and run outside a transaction; a best-effort write can still happen if
 * check() prunes an expired temporary entry, but nothing there needs the lock.
 */
export async function withScope<T>(
  mutate: boolean,
  fn: (scope: Scope) => Promise<T> | T,
): Promise<T> {
  if (!mutate) {
    const profile = await resolveProfile(db, false);
    const scope = new Scope(stateFromRaw(profile.scopeRules), undefined, async (state) => {
      await db
        .update(targetProfile)
        .set({ scopeRules: serializeScopeState(state), updatedAt: new Date() })
        .where(eq(targetProfile.id, profile.id));
    });
    return fn(scope);
  }

  return db.transaction(async (tx) => {
    const profile = await resolveProfile(tx, true);
    const scope = new Scope(stateFromRaw(profile.scopeRules), undefined, async (state) => {
      await tx
        .update(targetProfile)
        .set({ scopeRules: serializeScopeState(state), updatedAt: new Date() })
        .where(eq(targetProfile.id, profile.id));
    });
    return fn(scope);
  });
}
