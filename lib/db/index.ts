import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export * from "./schema";

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy env.example to .env.local and fill in the Supabase connection strings.",
    );
  }
  return url;
}

/**
 * Supabase's transaction pooler (port 6543) hands a different backend to each statement, so
 * prepared statements cannot be reused across them. postgres-js prepares by default, which
 * fails there with "prepared statement already exists" once traffic overlaps.
 */
const url = connectionString();

// Supabase demands TLS; the throwaway Postgres that CI and worktree-isolated agents run
// against speaks plaintext on loopback. Decide from the parsed host, never by matching the
// raw string: a password containing "@localhost:" would otherwise turn TLS off against a
// remote database, silently and with no error.
function isLoopbackHost(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    // Unparseable connection string: assume remote and keep TLS on. Failing closed here
    // costs a confusing error at worst; failing open would ship credentials in the clear.
    return false;
  }
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
}

const isLoopback = isLoopbackHost(url);

const client = postgres(url, {
  prepare: false,
  ssl: isLoopback ? false : "require",
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  // Seconds, all three. A connection the Supabase pooler drops without a FIN still looks open
  // from here, and the next query on it waits forever rather than failing: in the worker, whose
  // loops share a pool of four, that is enough to stop every queue at once with nothing in the
  // logs. Retiring connections before the pooler does keeps a dead socket out of the pool, and
  // the connect timeout means a pooler that has stopped answering fails a claim instead of
  // holding it.
  idle_timeout: 30,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
  connection: {
    // Server-side ceiling on any single statement, in milliseconds. Nothing this app runs is a
    // long query: the claims are single-row updates and the read models are small. Without it a
    // statement that blocks (a claim waiting on a row lock a crashed worker's transaction still
    // holds) waits on whatever the pooler's own default happens to be, which is minutes of a
    // silent worker loop before the cancel arrives.
    statement_timeout: 30_000,
    // Integration tests point this at a disposable schema so a run cannot see, or be handed,
    // another run's rows. Unset everywhere else, which leaves the server default (public).
    ...(process.env.DATABASE_SCHEMA ? { search_path: process.env.DATABASE_SCHEMA } : {}),
  },
});

export const db = drizzle(client, { schema });
export { client };

/**
 * Either the pool or an open transaction. Anything that has to be able to run inside a
 * caller's transaction takes this instead of reaching for `db` directly, which is how the
 * intake path gets its access check and its enqueue into one atomic unit.
 */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Re-exported so tests and workers can build their own predicates without each reaching into
// drizzle-orm separately.
export { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
