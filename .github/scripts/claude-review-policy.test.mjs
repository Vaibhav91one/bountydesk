import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The Claude review workflow runs with repository secrets and write access to pull requests, on
 * events a pull request author can cause. These assertions pin the guards that make that safe, so a
 * later edit that loosens one fails CI instead of shipping.
 */
const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const workflowPath = ".github/workflows/claude-review.yml";

test("the action and checkouts are pinned to full commit SHAs", async () => {
  const workflow = await read(workflowPath);
  assert.match(workflow, /anthropics\/claude-code-action@[0-9a-f]{40}/);
  for (const use of workflow.match(/uses: [^\s]+/g) ?? []) {
    assert.match(use, /@[0-9a-f]{40}$/, `${use} must be pinned to a commit SHA`);
  }
});

test("only same-repository pull requests and trusted commenters trigger a review", async () => {
  const workflow = await read(workflowPath);
  assert.match(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /^\s+pull_request:\s*$/m, "pull_request would run the PR's own copy of this file");
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /github\.event\.comment\.user\.type != 'Bot'/);
  assert.match(workflow, /\["OWNER","MEMBER","COLLABORATOR"\]/);
  // A comment on a fork's PR must still be refused once the PR is resolved.
  assert.match(workflow, /test "\$head_repo" = "\$REPOSITORY"/);
});

test("the policy comes from the default branch and the PR head is only data", async () => {
  const workflow = await read(workflowPath);
  const checkouts = workflow.split("uses: actions/checkout@").slice(1);
  assert.equal(checkouts.length, 2);
  assert.doesNotMatch(checkouts[0].split("- name:")[0], /ref:/, "the workspace root must be the default branch");
  assert.match(checkouts[1], /path: pr-head/);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.match(workflow, /--add-dir pr-head/);
});

test("Claude gets read tools and gh pr only, never a shell or write access", async () => {
  const workflow = await read(workflowPath);
  const allowed = workflow.match(/--allowedTools "([^"]+)"/)?.[1] ?? "";
  const tools = allowed.split(",");
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    const ok =
      ["Read", "Grep", "Glob", "mcp__github_inline_comment__create_inline_comment"].includes(tool) ||
      /^Bash\(gh pr (diff|view|comment):\*\)$/.test(tool);
    assert.ok(ok, `${tool} is not an allowed review tool`);
  }
  const disallowed = workflow.match(/--disallowedTools "([^"]+)"/)?.[1] ?? "";
  for (const tool of ["Write", "Edit", "MultiEdit", "WebFetch", "WebSearch"]) {
    assert.ok(disallowed.split(",").includes(tool), `${tool} must be disallowed`);
  }
});

test("credentials are referenced from secrets, never inlined", async () => {
  const workflow = await read(workflowPath);
  assert.match(workflow, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /sk-ant-|oauth_token_|anthropic_api_key:/);
});

test("the review carries no attribution and uses the agreed format", async () => {
  const workflow = await read(workflowPath);
  assert.match(workflow, /--model claude-sonnet-5/);
  assert.match(workflow, /<!-- claude-review head=/);
  assert.match(workflow, /<details><summary>/);
  assert.match(workflow, /No tables, no emoji/);
  assert.match(workflow, /no line saying who or what wrote the review/);
});
