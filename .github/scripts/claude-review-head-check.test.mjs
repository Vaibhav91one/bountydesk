import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkReviewHead, reviewedHead } from "./claude-review-head-check.mjs";

const OLD = "a".repeat(40);
const HEAD = "b".repeat(40);
const bot = (body) => ({ user: { login: "github-actions[bot]" }, body });
const summary = (sha) => bot(`<!-- claude-review head=${sha} -->\n## Code review\n\nNo findings.`);

test("the latest summary wins", () => {
  assert.equal(reviewedHead([summary(OLD), bot("unrelated"), summary(HEAD)]), HEAD);
  assert.equal(reviewedHead([summary(HEAD), summary(OLD)]), OLD);
});

test("a summary for the head passes", () => {
  assert.equal(checkReviewHead([summary(OLD), summary(HEAD)], HEAD).ok, true);
});

test("a summary for an earlier commit is stale", () => {
  const result = checkReviewHead([summary(OLD)], HEAD);
  assert.equal(result.ok, false);
  assert.match(result.message, new RegExp(`covers ${OLD}, not the head ${HEAD}`));
});

test("no summary at all fails", () => {
  assert.equal(checkReviewHead([], HEAD).ok, false);
  assert.equal(checkReviewHead([bot("## Code review")], HEAD).ok, false);
});

test("a marker from anyone but the workflow token is ignored", () => {
  const forged = { user: { login: "someone" }, body: `<!-- claude-review head=${HEAD} -->` };
  assert.equal(checkReviewHead([summary(OLD), forged], HEAD).ok, false);
});

test("the marker must open the comment and name a full sha", () => {
  assert.equal(reviewedHead([bot(`quote: <!-- claude-review head=${HEAD} -->`)]), null);
  assert.equal(reviewedHead([bot("<!-- claude-review head=abc123 -->")]), null);
  assert.equal(reviewedHead([bot(null), {}, null]), null);
});

test("the CLI reads paginated gh output and exits non-zero when stale", () => {
  const script = fileURLToPath(new URL("./claude-review-head-check.mjs", import.meta.url));
  const file = join(mkdtempSync(join(tmpdir(), "head-check-")), "comments.json");
  writeFileSync(file, JSON.stringify([[summary(OLD)], [summary(HEAD)]]));
  const env = { ...process.env, GITHUB_STEP_SUMMARY: "" };
  assert.match(execFileSync("node", [script, file, HEAD], { env, encoding: "utf8" }), /covers the head/);
  assert.throws(() => execFileSync("node", [script, file, OLD], { env, stdio: "pipe" }), { status: 1 });
});
