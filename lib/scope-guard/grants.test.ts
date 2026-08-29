import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Real Postgres is required: the point of this suite is that the FOR UPDATE lock plus the
 * insert-only trigger genuinely stop a grant token from being spent twice, not that
 * application code merely intends to.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let grantsModule: typeof import("./grants");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("scope_guard_grant");

  dbm = await import("@/lib/db");
  grantsModule = await import("./grants");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

test("a freshly minted grant verifies once for its exact target", async () => {
  const grant = await grantsModule.mint("juice-shop.local:3000", "nmap full port sweep");

  const result = await grantsModule.verify(grant.token, "juice-shop.local:3000");

  assert.deepEqual(result, {
    valid: true,
    reason: `human-approved grant for "nmap full port sweep" on juice-shop.local:3000`,
  });
});

test("verifying the same token twice fails the second time", async () => {
  const grant = await grantsModule.mint("juice-shop.local:3000", "nmap full port sweep");

  const first = await grantsModule.verify(grant.token, "juice-shop.local:3000");
  const second = await grantsModule.verify(grant.token, "juice-shop.local:3000");

  assert.equal(first.valid, true);
  assert.equal(second.valid, false);
  assert.equal(second.reason, "grant already used");
});

test("an unknown token is refused", async () => {
  const result = await grantsModule.verify("not-a-real-token", "juice-shop.local:3000");
  assert.deepEqual(result, { valid: false, reason: "unknown grant token" });
});

test("a target mismatch is refused without consuming the grant", async () => {
  const grant = await grantsModule.mint("juice-shop.local:3000", "nmap full port sweep");

  const mismatched = await grantsModule.verify(grant.token, "other.local:3000");
  assert.equal(mismatched.valid, false);
  assert.match(mismatched.reason, /grant was issued for juice-shop.local:3000/);

  // The grant remains active: a typo by the approved caller should not force a fresh
  // human approval.
  const correct = await grantsModule.verify(grant.token, "juice-shop.local:3000");
  assert.equal(correct.valid, true);
});

test("an expired grant is refused", async () => {
  const grant = await grantsModule.mint("juice-shop.local:3000", "nmap full port sweep", dbm.db, -1);

  const result = await grantsModule.verify(grant.token, "juice-shop.local:3000");
  assert.deepEqual(result, { valid: false, reason: "grant expired" });
});

/**
 * The concurrency proof. Sentinel's own SECURITY.md calls this bookkeeping, not enforcement:
 * "a single-use token an agent presents back," with no lock against two racing verify calls.
 * `Promise.all` (not sequential awaits) is what actually exercises the race - exactly one of
 * the N racing verifies must see `valid: true`, and the rest must fail with "grant already
 * used", never with a duplicate success or a crash from two conflicting inserts.
 */
test("N racing verify() calls for the same token: exactly one succeeds", async () => {
  const grant = await grantsModule.mint("juice-shop.local:3000", "nmap full port sweep");

  const CONCURRENCY = 20;
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => grantsModule.verify(grant.token, "juice-shop.local:3000")),
  );

  const succeeded = results.filter((r) => r.valid);
  const failed = results.filter((r) => !r.valid);

  assert.equal(succeeded.length, 1, "exactly one racing verify() call consumes the grant");
  assert.equal(failed.length, CONCURRENCY - 1);
  assert.ok(failed.every((r) => r.reason === "grant already used"));
});
