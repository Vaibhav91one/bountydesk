import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Real Postgres is required: the point of this suite is that the optimistic-concurrency guard
 * on the write-back path genuinely refuses a stale overwrite, not that application code merely
 * intends to. lib/scope-guard/scope.test.ts covers Scope's own policy logic against an
 * in-memory persistence stub; this file covers only the Drizzle-backed adapter.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let scopeProfile: typeof import("./scope-profile");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("scope_guard_profile");

  dbm = await import("@/lib/db");
  scopeProfile = await import("./scope-profile");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

async function insertProfile(scopeRules: unknown) {
  const [row] = await dbm.db
    .insert(dbm.targetProfile)
    .values({
      name: `scope-profile-${randomUUID()}`,
      imageDigest: `sha256:${"0".repeat(64)}`,
      scopeRules,
    })
    .returning();
  return row;
}

test("a persist call built from a stale read cannot overwrite a mutation committed after that read", async () => {
  const row = await insertProfile([{ allow: "keep.example" }]);

  // What Scope.pruneTemporary()'s fire-and-forget write does: capture the row as read once,
  // then write back later without re-checking whether anything else touched it meanwhile.
  const stalePersist = scopeProfile.makePersist(dbm.db, {
    id: row.id,
    config: row.config,
    scopeRules: row.scopeRules,
    updatedAt: row.updatedAt,
  });

  // A properly locked scope_add/scope_remove/scope_add_temporary call lands in between,
  // bumping updatedAt.
  await dbm.db
    .update(dbm.targetProfile)
    .set({ scopeRules: [{ allow: "keep.example" }, { allow: "added-by-mutation.example" }], updatedAt: new Date() })
    .where(dbm.eq(dbm.targetProfile.id, row.id));

  // The stale write must not land: its WHERE clause no longer matches the row's updatedAt.
  await stalePersist({ allow: ["keep.example"], temporary: [], updatedAt: new Date().toISOString() });

  const [after1] = await dbm.db.select().from(dbm.targetProfile).where(dbm.eq(dbm.targetProfile.id, row.id));
  const { allow } = scopeProfile.parseScopeRules(after1.scopeRules);
  assert.ok(allow.includes("added-by-mutation.example"), "the mutation that ran after the stale read must survive");
});

test("a persist call still writes normally when nothing else touched the row since it was read", async () => {
  const row = await insertProfile([{ allow: "keep.example" }]);

  const persist = scopeProfile.makePersist(dbm.db, {
    id: row.id,
    config: row.config,
    scopeRules: row.scopeRules,
    updatedAt: row.updatedAt,
  });
  await persist({ allow: ["keep.example", "added-by-persist.example"], temporary: [], updatedAt: new Date().toISOString() });

  const [after1] = await dbm.db.select().from(dbm.targetProfile).where(dbm.eq(dbm.targetProfile.id, row.id));
  const { allow } = scopeProfile.parseScopeRules(after1.scopeRules);
  assert.ok(allow.includes("added-by-persist.example"), "the write must have gone through");
});

test("withScope(false, ...)'s temporaryList prune cannot clobber a withScope(true, ...) mutation that commits first", async () => {
  const row = await insertProfile([
    { allow: "keep.example" },
    { temporary: "gone.example", expiresAt: Date.now() - 1000 },
  ]);
  process.env.SCOPE_GUARD_TARGET_PROFILE = row.name;

  try {
    await scopeProfile.withScope(false, async (scope) => {
      // Reads the row (capturing this row's updatedAt), then computes the pruned temporary
      // list and fires the fire-and-forget write - all before the mutation below runs.
      scope.temporaryList();

      // A concurrent, properly locked mutation commits its own newer state on top.
      await scopeProfile.withScope(true, async (mutating) => {
        assert.equal(await mutating.add("added-during-race.example"), null);
      });

      // Give the prune's fire-and-forget write, issued above, a turn to actually reach
      // Postgres before this callback returns.
      await new Promise((resolve) => setImmediate(resolve));
    });

    const [finalRow] = await dbm.db.select().from(dbm.targetProfile).where(dbm.eq(dbm.targetProfile.id, row.id));
    const { allow } = scopeProfile.parseScopeRules(finalRow.scopeRules);
    assert.ok(allow.includes("keep.example"));
    assert.ok(allow.includes("added-during-race.example"), "the locked mutation must survive the read path's prune write");
  } finally {
    delete process.env.SCOPE_GUARD_TARGET_PROFILE;
  }
});
