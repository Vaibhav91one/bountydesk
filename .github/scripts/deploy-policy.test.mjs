import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The deploy workflow writes to the production database and replaces the production worker on
 * every merge, with nobody approving the run. These assertions pin the guards that keep that safe,
 * so a later edit that loosens one fails CI instead of shipping.
 */
const workflow = await readFile(new URL("../workflows/deploy.yml", import.meta.url), "utf8");

test("every action is pinned to a full commit SHA", () => {
  const uses = workflow.match(/uses: [^\s]+/g) ?? [];
  assert.ok(uses.length > 0);
  for (const use of uses) {
    assert.match(use, /@[0-9a-f]{40}$/, `${use} must be pinned to a commit SHA`);
  }
});

test("zcli is a pinned release verified by checksum", () => {
  assert.match(workflow, /ZCLI_VERSION: v\d+\.\d+\.\d+\n/);
  assert.match(workflow, /ZCLI_SHA256: [0-9a-f]{64}\n/);
  assert.match(workflow, /sha256sum -c -/);
  assert.doesNotMatch(workflow, /install\.sh|\| *sh\b|npm (i|install) .*zcli/, "no unpinned installer");
});

test("the token is read-only and checkouts keep no credentials", () => {
  assert.match(workflow, /^permissions:\n {2}contents: read\n\n/m);
  assert.equal((workflow.match(/permissions:/g) ?? []).length, 1, "no job widens the token");
  const checkouts = (workflow.match(/uses: actions\/checkout@/g) ?? []).length;
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, checkouts);
});

test("deploys queue in order and are never cancelled part way", () => {
  assert.match(workflow, /^concurrency:\n {2}group: deploy-production\n {2}cancel-in-progress: false$/m);
  assert.doesNotMatch(workflow, /cancel-in-progress: true/);
});

test("only main reaches production", () => {
  assert.match(workflow, /^ {4}branches: \[main\]$/m);
  assert.doesNotMatch(workflow, /pull_request/);
  // workflow_dispatch can be started from any branch, so each job checks the ref itself.
  assert.equal((workflow.match(/^ {4}if: github\.ref == 'refs\/heads\/main'$/gm) ?? []).length, 2);
  assert.match(workflow, /^ {4}needs: migrate$/m);
});

test("secrets are referenced only where they are used, never inlined", () => {
  assert.deepEqual(
    [...workflow.matchAll(/\$\{\{ secrets\.(\w+) \}\}/g)].map((m) => m[1]).sort(),
    ["DIRECT_URL", "ZEROPS_TOKEN"],
  );
  assert.match(workflow, / {10}DIRECT_URL: \$\{\{ secrets\.DIRECT_URL \}\}\n {8}run: npm run db:migrate/);
  assert.match(workflow, / {10}ZEROPS_TOKEN: \$\{\{ secrets\.ZEROPS_TOKEN \}\}\n {8}run: .*zcli" push bdworker/);
  assert.doesNotMatch(workflow, /postgres(ql)?:\/\//, "no connection string");
  assert.doesNotMatch(workflow, /zcli" login/, "the token stays out of argv");
});

test("every job has a timeout", () => {
  const jobs = (workflow.match(/^ {4}runs-on: /gm) ?? []).length;
  assert.equal(jobs, 2);
  assert.equal((workflow.match(/^ {4}timeout-minutes: \d+$/gm) ?? []).length, jobs);
});
