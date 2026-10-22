import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const RUN = fileURLToPath(new URL("./run.ts", import.meta.url));

function runBench(databaseUrl: string | undefined) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  if (databaseUrl) env.DATABASE_URL = databaseUrl;
  return spawnSync(process.execPath, ["--import", "tsx", RUN, "file"], { env, encoding: "utf8" });
}

test("bench runner refuses a non-local database so a benchmark run can never write to production", () => {
  const out = runBench("postgresql://u:p@db.example.com:5432/app");
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /only runs against a local database/);
});

test("bench runner refuses to start with no DATABASE_URL at all", () => {
  const out = runBench(undefined);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /DATABASE_URL is not set/);
});
