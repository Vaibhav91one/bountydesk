import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Real Postgres is required: the point of this suite is that the advisory-lock-serialized
 * transaction actually prevents the duplicate-seq / forked-chain bug Sentinel's file-backed
 * audit log had, not that application code merely intends to.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let auditModule: typeof import("./audit");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("scope_guard_audit");

  dbm = await import("@/lib/db");
  auditModule = await import("./audit");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function baseInput(overrides: Partial<Parameters<typeof auditModule.append>[0]> = {}) {
  return {
    actor: "agent",
    auth: "bearer-verified",
    action: "scope_check",
    args: { target: "example.test" },
    verdict: "allowed" as const,
    reason: "matches scoped entry",
    ...overrides,
  };
}

test("the first append starts the chain at seq 0 with GENESIS as its previous hash", async () => {
  const entry = await auditModule.append(baseInput());
  assert.equal(entry.seq, 0);
  assert.equal(entry.prevHash, "GENESIS");
  assert.equal(entry.hash.length, 64);
});

test("each append advances seq by exactly one and chains to the previous hash", async () => {
  const a = await auditModule.append(baseInput({ action: "scope_check" }));
  const b = await auditModule.append(baseInput({ action: "scope_add", verdict: "mutated", reason: "entry added" }));
  const c = await auditModule.append(baseInput({ action: "audit_read" }));

  assert.equal(b.seq, a.seq + 1);
  assert.equal(c.seq, b.seq + 1);
  assert.equal(b.prevHash, a.hash);
  assert.equal(c.prevHash, b.hash);

  const result = await auditModule.verifyChain();
  assert.deepEqual(result, { ok: true });
});

test("hash verification survives jsonb key normalization for nested args", async () => {
  await auditModule.append(
    baseInput({
      action: "http_probe",
      args: {
        url: "http://localhost:3000/path",
        method: "POST",
        headers: { "x-z": "last", "x-a": "first" },
        nested: [{ z: 2, a: 1 }],
      },
      reason: "HTTP 200 in 1ms",
    }),
  );

  const result = await auditModule.verifyChain();
  assert.deepEqual(result, { ok: true });
});

test("read() returns entries newest-first", async () => {
  const entries = await auditModule.read(10);
  const seqs = entries.map((e) => e.seq);
  const sortedDesc = [...seqs].sort((x, y) => y - x);
  assert.deepEqual(seqs, sortedDesc);
});

/**
 * The concurrency proof. Sentinel's bug was exactly this: `nextSeq()` cached the value from
 * its first call and just kept adding 1 to the cache on every later call without persisting
 * the advance, so appends 3+ collided on the same seq; there was also no lock at all, so two
 * appends racing `Promise.all` could read the same tail hash and both mint the same `prev`.
 * `Promise.all` (not sequential awaits) is what actually exercises the race: this must
 * genuinely serialize inside Postgres, not merely appear correct because Node ran the calls
 * one at a time.
 */
test("concurrent appends via Promise.all get distinct, sequential seq values and an unbroken hash chain", async () => {
  const before = await auditModule.read(1);
  const startSeq = before.length > 0 ? before[0].seq + 1 : 0;

  const CONCURRENCY = 25;
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      auditModule.append(baseInput({ action: "concurrent_probe", args: { i } })),
    ),
  );

  const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
  const expected = Array.from({ length: CONCURRENCY }, (_, i) => startSeq + i);
  assert.deepEqual(seqs, expected, "every concurrent append got a distinct, contiguous seq");

  const verified = await auditModule.verifyChain();
  assert.deepEqual(verified, { ok: true }, "the hash chain is unbroken after concurrent writers");
});
