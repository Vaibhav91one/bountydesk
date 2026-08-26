import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Migration 0005 against a database that already has the duplicates it is meant to fix.
 *
 * `target_profile.name` had no constraint until 0005, and the seeder that shipped before it
 * used an unqualified ON CONFLICT DO NOTHING, which on a table whose only unique column is a
 * generated primary key never conflicts. Running it twice left two rows with the same name,
 * so CREATE UNIQUE INDEX would have failed on exactly the databases someone had been
 * developing against. A fresh-schema test cannot see that, because a fresh schema has no
 * duplicates: this one puts them back and re-runs the migration's own statements.
 */
let schema: import("./testing").DisposableSchema;
let dbm: typeof import("./index");

const STATEMENTS = fs
  .readFileSync(path.join(process.cwd(), "drizzle", "0005_hard_anita_blake.sql"), "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

before(async () => {
  const { createSchema } = await import("./testing");
  schema = await createSchema("mig0005");
  dbm = await import("./index");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

/** postgres-js returns loosely typed rows; the tests know their own shapes. */
async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await schema.admin.unsafe(text, params as never)) as unknown as T[];
}

/** Undo 0005 so the duplicates it protects against can be created again. */
async function rewind() {
  await schema.admin.unsafe(`set search_path to "${schema.name}"`);
  await schema.admin.unsafe(`drop index if exists "target_profile_name_key"`);
  await schema.admin.unsafe(`delete from report`);
  await schema.admin.unsafe(`delete from connected_repository`);
  await schema.admin.unsafe(`delete from github_installation`);
  await schema.admin.unsafe(`delete from target_profile`);
}

async function replay() {
  for (const statement of STATEMENTS) {
    await schema.admin.unsafe(`set local search_path to "${schema.name}"; ${statement}`);
  }
}

async function insertProfile(
  name: string,
  digest: string,
  snapshotId: string | null = null,
): Promise<string> {
  const [row] = await query<{ id: string }>(
    `insert into "${schema.name}".target_profile (name, image_digest, snapshot_id)
     values ($1, $2, $3) returning id`,
    [name, digest, snapshotId],
  );
  return row.id;
}

test("identical duplicates are consolidated and their references repointed", async () => {
  await rewind();

  const digest = `sha256:${"a".repeat(64)}`;
  const first = await insertProfile("juice-shop-v17.3.0", digest);
  const second = await insertProfile("juice-shop-v17.3.0", digest);
  await insertProfile("other-target", digest);

  // A repository bound to the row the migration is about to delete.
  const [installation] = await query<{ id: string }>(
    `insert into "${schema.name}".github_installation (installation_id, account_login, account_id)
     values (91001, 'acme', 77) returning id`,
  );
  const [repo] = await query<{ id: string }>(
    `insert into "${schema.name}".connected_repository (installation_id, repo_id, full_name, target_profile_id)
     values ($1, 91002, 'acme/reports', $2) returning id`,
    [installation.id, second],
  );
  await schema.admin.unsafe(
    `insert into "${schema.name}".report (channel, source_ref, title, body, connected_repository_id, target_profile_id)
     values ('github', 'github:91002:issue:1', 't', 'b', $1, $2)`,
    [repo.id, second],
  );

  await replay();

  const profiles = await query<{ id: string; name: string }>(
    `select id, name from "${schema.name}".target_profile order by name`,
  );
  assert.deepEqual(
    profiles.map((p) => p.name),
    ["juice-shop-v17.3.0", "other-target"],
  );

  // The survivor is the oldest row, and nothing still points at the deleted one.
  assert.equal(profiles[0].id, first);

  const [boundRepo] = await query<{ target_profile_id: string }>(
    `select target_profile_id from "${schema.name}".connected_repository where id = $1`,
    [repo.id],
  );
  assert.equal(boundRepo.target_profile_id, first);

  const [boundReport] = await query<{ target_profile_id: string }>(
    `select target_profile_id from "${schema.name}".report limit 1`,
  );
  assert.equal(boundReport.target_profile_id, first);
});

test("duplicates that pin different targets stop the migration", async () => {
  await rewind();

  // Same name, different image digest. Choosing a winner here would silently repoint reports
  // at a target nobody selected, which is what binding scope server-side exists to prevent.
  await insertProfile("juice-shop-v17.3.0", `sha256:${"a".repeat(64)}`);
  await insertProfile("juice-shop-v17.3.0", `sha256:${"b".repeat(64)}`);

  await assert.rejects(replay(), /pinned settings differ/);

  // The migration stopped before touching anything.
  const profiles = await query<{ n: number }>(
    `select count(*)::int as n from "${schema.name}".target_profile`,
  );
  assert.equal(profiles[0].n, 2);
});

test("a missing snapshot and an empty snapshot are different targets", async () => {
  await rewind();

  const digest = `sha256:${"a".repeat(64)}`;
  await insertProfile("juice-shop-v17.3.0", digest, null);
  await insertProfile("juice-shop-v17.3.0", digest, "");

  await assert.rejects(replay(), /pinned settings differ/);

  const profiles = await query<{ snapshot_id: string | null }>(
    `select snapshot_id from "${schema.name}".target_profile order by snapshot_id nulls first`,
  );
  assert.deepEqual(
    profiles.map((profile) => profile.snapshot_id),
    [null, ""],
  );
});

test("a database with no duplicates migrates unchanged", async () => {
  await rewind();

  const only = await insertProfile("juice-shop-v17.3.0", `sha256:${"a".repeat(64)}`);
  await replay();

  const profiles = await query<{ id: string }>(
    `select id from "${schema.name}".target_profile`,
  );
  assert.deepEqual(
    profiles.map((p) => p.id),
    [only],
  );

  const indexes = await query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = $1 and indexname = 'target_profile_name_key'`,
    [schema.name],
  );
  assert.equal(indexes.length, 1);
});
