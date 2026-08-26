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
const client = postgres(connectionString(), {
  prepare: false,
  ssl: "require",
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
});

export const db = drizzle(client, { schema });
export { client };
