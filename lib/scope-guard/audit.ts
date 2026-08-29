import { createHash } from "node:crypto";

import { db, scopeGuardAudit, sql, type Executor } from "@/lib/db";

/**
 * The scope-guard audit log: a Postgres-backed, hash-chained, append-only trail.
 *
 * `seq`/`prev_hash` assignment happens in the same transaction as the insert, serialized by a
 * Postgres advisory lock. A plain `SELECT ... FOR UPDATE` on "the latest row" doesn't work here
 * the way it does for lib/agent-sessions/poller.ts's report row: that pattern locks and then
 * *updates* the same row, so a second transaction blocked on the lock sees the first
 * transaction's change once it's released. An audit append never updates the previous row, it
 * inserts a new one - so a second transaction, unblocked, would still see the same "latest row"
 * the first transaction saw and compute the same next seq. An advisory lock has no row to be
 * stale about: it just serializes the read-compute-insert critical section itself, which is
 * exactly what an append-only chain needs.
 */

export interface AuditEntry {
  seq: number;
  prevHash: string;
  hash: string;
  ts: Date;
  actor: string;
  auth: string;
  action: string;
  args: Record<string, unknown>;
  verdict: "allowed" | "denied" | "mutated";
  reason: string;
}

export type AuditAppendInput = Omit<AuditEntry, "seq" | "prevHash" | "hash" | "ts">;

const GENESIS_HASH = "GENESIS";

/**
 * Arbitrary, stable key for the transaction-scoped advisory lock guarding the audit chain.
 * Picked once and never reused for anything else in this codebase; changing it is safe (it
 * only needs to be internally consistent) but pointless.
 */
const AUDIT_CHAIN_LOCK_KEY = 0x5c0be_6001;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Canonical payload the hash commits to, independent of jsonb object-key ordering. */
function hashPayload(record: Omit<AuditEntry, "hash">): string {
  return JSON.stringify({
    seq: record.seq,
    prevHash: record.prevHash,
    ts: record.ts.toISOString(),
    actor: record.actor,
    auth: record.auth,
    action: record.action,
    args: canonicalize(record.args),
    verdict: record.verdict,
    reason: record.reason,
  });
}

function toEntry(row: typeof scopeGuardAudit.$inferSelect): AuditEntry {
  return {
    seq: row.seq,
    prevHash: row.prevHash,
    hash: row.hash,
    ts: row.ts,
    actor: row.actor,
    auth: row.auth,
    action: row.action,
    args: row.args as Record<string, unknown>,
    verdict: row.verdict,
    reason: row.reason,
  };
}

/**
 * Appends one entry to the chain. Runs in its own transaction (or the caller's, if one is
 * passed in) so the advisory lock, the tail read, and the insert are one atomic unit: nothing
 * else can interleave a seq/prev_hash assignment between this call's read and its write.
 */
export async function append(entry: AuditAppendInput, executor: Executor = db): Promise<AuditEntry> {
  const run = async (tx: Executor): Promise<AuditEntry> => {
    // Transaction-scoped: released automatically at commit or rollback, never leaked.
    await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`);

    const [tail] = await tx
      .select({ seq: scopeGuardAudit.seq, hash: scopeGuardAudit.hash })
      .from(scopeGuardAudit)
      .orderBy(sql`${scopeGuardAudit.seq} desc`)
      .limit(1);

    const seq = tail ? tail.seq + 1 : 0;
    const prevHash = tail?.hash ?? GENESIS_HASH;
    const ts = new Date();
    const payload = hashPayload({ seq, prevHash, ts, ...entry });
    const hash = createHash("sha256").update(prevHash + payload).digest("hex");

    const [row] = await tx
      .insert(scopeGuardAudit)
      .values({
        seq,
        prevHash,
        hash,
        ts,
        actor: entry.actor,
        auth: entry.auth,
        action: entry.action,
        args: entry.args,
        verdict: entry.verdict,
        reason: entry.reason,
      })
      .returning();

    return toEntry(row);
  };

  // "executor" may already be a transaction handed down by a caller doing several audited
  // writes as one unit; only open a new one when it isn't (the plain `db` pool has no
  // ambient transaction of its own, and a nested db.transaction() call is what every other
  // Executor-typed function in this codebase avoids the same way).
  return executor === db ? db.transaction((tx) => run(tx)) : run(executor);
}

/** Returns the last `limit` entries, newest first. */
export async function read(limit = 25, executor: Executor = db): Promise<AuditEntry[]> {
  const rows = await executor
    .select()
    .from(scopeGuardAudit)
    .orderBy(sql`${scopeGuardAudit.seq} desc`)
    .limit(limit);
  return rows.map(toEntry);
}

/**
 * Verifies the whole chain is unbroken: every row's seq is contiguous from 0, and every row's
 * hash correctly commits to its own fields plus the previous row's hash. Not on the hot path -
 * this is what a test (or an incident review) calls to prove tamper-evidence actually holds.
 */
export async function verifyChain(executor: Executor = db): Promise<{ ok: boolean; brokenAtSeq?: number }> {
  const rows = await executor.select().from(scopeGuardAudit).orderBy(scopeGuardAudit.seq);
  let prevHash = GENESIS_HASH;
  let expectedSeq = 0;
  for (const row of rows) {
    const entry = toEntry(row);
    if (entry.seq !== expectedSeq) return { ok: false, brokenAtSeq: entry.seq };
    expectedSeq += 1;
    if (entry.prevHash !== prevHash) return { ok: false, brokenAtSeq: entry.seq };
    const expectedHash = createHash("sha256")
      .update(prevHash + hashPayload(entry))
      .digest("hex");
    if (expectedHash !== entry.hash) return { ok: false, brokenAtSeq: entry.seq };
    prevHash = entry.hash;
  }
  return { ok: true };
}
