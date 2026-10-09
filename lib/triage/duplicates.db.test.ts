import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * findDuplicateCandidates against real Postgres, to prove the pg_trgm wiring itself (migration
 * 0050): that CREATE EXTENSION IF NOT EXISTS pg_trgm ran, that similarity() resolves, and that a
 * genuine reword with almost no shared whole words still surfaces. duplicates.test.ts covers the
 * pure ranking logic without a database.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let duplicates: typeof import("./duplicates");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("triage_duplicates");
  dbm = await import("@/lib/db");
  duplicates = await import("./duplicates");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function seedReport(title: string, body: string): Promise<string> {
  seq += 1;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({ channel: "github", sourceRef: `github:1:issue:${seq}`, title, body })
    .returning({ id: dbm.report.id });
  return row.id;
}

test("a near-verbatim reword with almost no shared whole words still surfaces via similarity()", async () => {
  const target = await seedReport(
    "Reflected cross site scripting in the search box",
    "The /search endpoint reflects the q parameter unescaped into the page, so a script tag in q executes in the victim's browser.",
  );
  // Same characters, different word choices and order: Jaccard overlap is near zero, but trigram
  // similarity (shared three-character substrings) should still catch it.
  await seedReport(
    "Unescaped reflexion of q into /search allows a scriptable tag to run",
    "The search endpoint reflexion of its q param is unescaped; a scriptable tag placed in q will run in a victim browser.",
  );
  await seedReport("Unrelated billing timeout", "The invoice export times out after five minutes on large accounts.");

  const [reportRow] = await dbm.db.select().from(dbm.report).where(dbm.eq(dbm.report.id, target));
  const candidates = await duplicates.findDuplicateCandidates(target, reportRow.title, reportRow.body);

  assert.ok(candidates.length > 0, "the reworded report should surface as a candidate");
  assert.ok(
    !candidates.some((c) => c.title === "Unrelated billing timeout"),
    "an unrelated report must not surface",
  );
});
