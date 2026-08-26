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
});

export const db = drizzle(client, { schema });
export { client };
