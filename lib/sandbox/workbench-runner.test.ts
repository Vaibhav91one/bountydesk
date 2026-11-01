import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const RUNNER = "sandbox-images/workbench/workbench-runner.mjs";
const SENTINEL = "BOUNTYDESK_WORKBENCH_RESULT ";

function runNuclei(templatesDir: string) {
  const dir = mkdtempSync(join(tmpdir(), "wb-runner-"));
  const params = join(dir, "params.json");
  writeFileSync(params, JSON.stringify({ tool: "nuclei", targetOrigin: "http://target:3000", path: "/" }));
  const run = spawnSync("node", [RUNNER, params], {
    encoding: "utf8",
    env: { ...process.env, BOUNTYDESK_NUCLEI_TEMPLATES_DIR: templatesDir },
  });
  const line = run.stdout.split("\n").find((l) => l.startsWith(SENTINEL));
  assert.ok(line, "the runner always prints a result line");
  return JSON.parse(line.slice(SENTINEL.length)) as { tool: string; exitCode: number; stdout: string; stderr: string };
}

test("nuclei refuses to scan when the templates directory is missing", () => {
  const result = runNuclei(join(tmpdir(), "wb-no-such-templates-dir"));
  assert.equal(result.exitCode, -1, "a zero-template scan must not look like a clean scan");
  assert.match(result.stderr, /templates missing or empty/);
});

test("nuclei refuses to scan when the templates directory is empty", () => {
  const result = runNuclei(mkdtempSync(join(tmpdir(), "wb-empty-templates-")));
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /templates missing or empty/);
});
