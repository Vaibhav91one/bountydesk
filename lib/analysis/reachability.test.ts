import assert from "node:assert/strict";
import test from "node:test";

import { assessReachability, type ReachabilitySignal } from "./reachability";
import { type SourceReader } from "@/lib/build-onboarding/classify";

function reader(files: Record<string, string>): SourceReader {
  return { async readFile(path: string) { return files[path] ?? null; } };
}

test("a declared dependency is a reachable candidate", async () => {
  const src = reader({ "package.json": `{ "dependencies": { "lodash": "4.17.20" } }` });
  const out = await assessReachability(src, [{ kind: "dependency", value: "lodash@4.17.20" }]);
  assert.equal(out.status, "reachable-candidate");
  assert.equal(out.findings[0]?.status, "present");
  assert.match(out.summary, /reproduction is warranted/);
});

test("a dependency absent from a present manifest is unreachable, with evidence", async () => {
  const src = reader({ "package.json": `{ "dependencies": { "react": "18.0.0" } }` });
  const out = await assessReachability(src, [{ kind: "dependency", value: "log4j" }]);
  assert.equal(out.status, "unreachable");
  assert.equal(out.findings[0]?.status, "absent");
  assert.match(out.findings[0]?.evidence ?? "", /not declared in package\.json/);
});

test("no manifest means the dependency check is unknown, not a false dismissal", async () => {
  const out = await assessReachability(reader({}), [{ kind: "dependency", value: "log4j" }]);
  assert.equal(out.status, "unknown");
  assert.equal(out.findings[0]?.status, "unknown");
});

test("a symbol found in a named file is present", async () => {
  const src = reader({ "app/db.py": "def run_query(id):\n    cursor.execute(f'... {id}')" });
  const signal: ReachabilitySignal = { kind: "symbol", value: "run_query", files: ["app/db.py"] };
  const out = await assessReachability(src, [signal]);
  assert.equal(out.status, "reachable-candidate");
});

test("a symbol with no named files is unknown (needs a call graph)", async () => {
  const out = await assessReachability(reader({}), [{ kind: "symbol", value: "run_query" }]);
  assert.equal(out.status, "unknown");
  assert.match(out.findings[0]?.evidence ?? "", /call graph/);
});

test("mixed signals: any present makes it a reachable candidate", async () => {
  const src = reader({ "composer.json": `{ "require": { "monolog/monolog": "2.0" } }` });
  const out = await assessReachability(src, [
    { kind: "dependency", value: "monolog/monolog" },
    { kind: "endpoint", value: "/admin", files: ["routes.php"] },
  ]);
  assert.equal(out.status, "reachable-candidate");
});

test("no signals means unknown", async () => {
  const out = await assessReachability(reader({}), []);
  assert.equal(out.status, "unknown");
  assert.match(out.summary, /no reachability signals/);
});
