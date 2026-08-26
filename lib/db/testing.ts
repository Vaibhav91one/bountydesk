import fs from "node:fs";
import path from "node:path";

import postgres from "postgres";

/**
 * Disposable-schema harness for tests that need a real Postgres.
 *
 * The guarantees these tests assert are the database's: SKIP LOCKED, unique constraints,
 * the triggers that refuse UPDATE and DELETE on the evidence tables. A mock would agree
 * with a wrong implementation, and those same triggers mean a test cannot tidy up after
 * itself. So each run gets a schema of its own, the committed migrations are replayed into
 * it, and the whole thing is dropped at the end.
 *
 * Call `createSchema` before importing anything that opens the pool: it sets
 * DATABASE_SCHEMA, and `@/lib/db` reads that when it constructs the connection.
 */
export type DisposableSchema = {
  name: string;
  admin: postgres.Sql;
  drop: () => Promise<void>;
};

function isLoopback(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
}

export async function createSchema(label: string): Promise<DisposableSchema> {
  const name = `bd_${label}_${process.pid}_${Date.now().toString(36)}`;
  process.env.DATABASE_SCHEMA = name;

  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL must be set to run these tests");

  const admin = postgres(url, {
    ssl: isLoopback(url) ? false : "require",
    max: 1,
    onnotice: () => {},
  });

  await admin.unsafe(`create schema "${name}"`);

  const dir = path.join(process.cwd(), "drizzle");
  const journal = JSON.parse(
    fs.readFileSync(path.join(dir, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };

  for (const entry of journal.entries) {
    const sqlText = fs.readFileSync(path.join(dir, `${entry.tag}.sql`), "utf8");
    for (const statement of sqlText.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (!trimmed) continue;
      const scoped = trimmed
        // drizzle-kit hard-qualifies everything as "public", so search_path alone would not
        // redirect it and the enums would collide with the real ones.
        .replace(/"public"\./g, `"${name}".`)
        .replace(/\bpublic\./g, `"${name}".`)
        // The lockdown migration revokes across a whole schema. Scoping every "SCHEMA public"
        // ON as well as IN, keeps a test run from altering privileges outside itself.
        .replace(/\bSCHEMA public\b/g, `SCHEMA "${name}"`);
      await admin.unsafe(`set local search_path to "${name}"; ${scoped}`);
    }
  }

  return {
    name,
    admin,
    drop: async () => {
      await admin.unsafe(`drop schema if exists "${name}" cascade`);
      await admin.end({ timeout: 5 });
    },
  };
}
