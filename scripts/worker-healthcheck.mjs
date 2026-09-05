import postgres from "postgres";

const url = process.env.DATABASE_URL?.trim();

if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

function isLoopbackHost(raw) {
  try {
    const host = new URL(raw).hostname;
    return ["localhost", "127.0.0.1", "::1"].includes(host);
  } catch {
    return false;
  }
}

const client = postgres(url, {
  prepare: false,
  ssl: isLoopbackHost(url) ? false : "require",
  max: 1,
  connect_timeout: 5,
  idle_timeout: 1,
});

try {
  await client`select 1`;
  await client.end({ timeout: 1 });
  console.log("ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  try {
    await client.end({ timeout: 1 });
  } catch {
    // The process is already failing, and the next health check gets a clean process.
  }
  process.exit(1);
}
