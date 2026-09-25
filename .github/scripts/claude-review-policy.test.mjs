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
  const checkouts = workflow.split("uses: actions/checkout@").slice(1).map((c) => c.split("- name:")[0]);
  assert.equal(checkouts.length, 3);
  assert.doesNotMatch(checkouts[0], /ref:/, "the workspace root must be the default branch");
  assert.match(checkouts[1], /path: pr-head/);
  assert.doesNotMatch(checkouts[2], /ref:/, "the head check must run the default branch's script");
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 3);
  assert.match(workflow, /--add-dir pr-head/);
});

// The one Claude Code review step (the subscription primary). The fallback is not an agent; it is
// a script step, checked separately below.
const primaryStep = (workflow) => {
  const steps = workflow.split("uses: anthropics/claude-code-action@").slice(1).map((s) => s.split("- name:")[0]);
  assert.equal(steps.length, 1, "there is exactly one Claude Code review step, the primary");
  return steps[0];
};
const fallbackScriptPath = ".github/scripts/vyceai-review.mjs";

test("the primary review gets read tools and gh pr only, never a shell or write access", async () => {
  const workflow = await read(workflowPath);
  const step = primaryStep(workflow);
  const allowed = step.match(/--allowedTools "([^"]+)"/)?.[1] ?? "";
  assert.ok(allowed.length > 0);
  for (const tool of allowed.split(",")) {
    const ok =
      ["Read", "Grep", "Glob", "mcp__github_inline_comment__create_inline_comment"].includes(tool) ||
      /^Bash\(gh pr (diff|view|comment):\*\)$/.test(tool);
    assert.ok(ok, `${tool} is not an allowed review tool`);
  }
  const disallowed = step.match(/--disallowedTools "([^"]+)"/)?.[1] ?? "";
  for (const tool of ["Write", "Edit", "MultiEdit", "WebFetch", "WebSearch"]) {
    assert.ok(disallowed.split(",").includes(tool), `${tool} must be disallowed`);
  }
  assert.match(step, /--add-dir pr-head/);
  const promptLines = step.split("prompt: |")[1].split("\n").slice(1);
  const end = promptLines.findIndex((line) => line.trim() !== "" && !line.startsWith(" ".repeat(12)));
  const prompt = promptLines.slice(0, end === -1 ? undefined : end).join("\n").trim();
  assert.ok(prompt.includes("<!-- claude-review head="));
});

test("the fallback is a single scripted call with no agent, no tools and no pull request code", async () => {
  const workflow = await read(workflowPath);
  const fallback = workflow.split("- name: Review (fallback")[1]?.split("\n  head-check:")[0] ?? "";
  assert.ok(fallback, "the fallback step exists");
  // It runs the committed script, not a Claude Code agent, and never checks out or executes PR code.
  assert.match(fallback, /run: node \.github\/scripts\/vyceai-review\.mjs/);
  assert.doesNotMatch(fallback, /uses: anthropics\/claude-code-action/);
  assert.doesNotMatch(fallback, /--add-dir pr-head/);
  assert.doesNotMatch(fallback, /--allowedTools|--disallowedTools/);

  // The script itself: the diff is data (read through gh, never executed), the key comes from the
  // environment and goes only to VyceAI, and the posted comment always carries the head marker.
  const script = await read(fallbackScriptPath);
  assert.match(script, /process\.env\.VYCEAI_API_KEY/);
  assert.match(script, /https:\/\/vyceai\.com\/v1\/messages/);
  assert.match(script, /deepseek-v4-flash/);
  assert.match(script, /claude-review head=/);
  assert.doesNotMatch(script, /exec(Sync)?\(|shell: true/, "no shell; gh runs through execFile arg arrays");
});

test("credentials are referenced from secrets, never inlined", async () => {
  const workflow = await read(workflowPath);
  const primary = primaryStep(workflow);
  assert.match(primary, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  assert.doesNotMatch(primary, /anthropic_api_key:/);
  // The only API key is VyceAI's; it is passed once, as an env var from secrets, to the fallback.
  assert.match(workflow, /VYCEAI_API_KEY: \$\{\{ secrets\.VYCEAI_API_KEY \}\}/);
  assert.equal((workflow.match(/secrets\.VYCEAI_API_KEY/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /sk-ant-|oauth_token_|sk-[A-Za-z0-9]{20}/);
  const script = await read(fallbackScriptPath);
  assert.doesNotMatch(script, /sk-ant-|sk-[A-Za-z0-9]{20}/, "the script inlines no key");
});

test("the fallback runs only when the subscription review failed", async () => {
  const workflow = await read(workflowPath);
  assert.match(workflow, /- name: Review\n\s+id: claude\n[\s\S]*?continue-on-error: true/);
  assert.match(workflow, /if: steps\.claude\.outcome == 'failure'/);
});

test("the review carries no attribution and uses the agreed format", async () => {
  const workflow = await read(workflowPath);
  assert.match(workflow, /--model claude-sonnet-5/);
  assert.match(workflow, /<!-- claude-review head=/);
  assert.match(workflow, /<details><summary>/);
  assert.match(workflow, /No tables, no emoji/);
  assert.match(workflow, /no line saying who or what wrote the review/);
});

// The job's block: from its `  name:` line to the next top-level job or the end of the file.
const job = (workflow, name) => workflow.split(new RegExp(`^  ${name}:\\s*$`, "m"))[1]?.split(/^  \S/m)[0] ?? "";
const permissions = (block) =>
  Object.fromEntries([...(block.split(/^    permissions:\s*$/m)[1] ?? "").matchAll(/^      ([\w-]+): (\w+)$/gm)].map((m) => [m[1], m[2]]));

test("every push to a pull request is reviewed, and a new push cancels the stale review", async () => {
  const workflow = await read(workflowPath);
  const types = workflow.match(/pull_request_target:\s*\n\s*types: \[([^\]]+)\]/)?.[1].split(/,\s*/);
  assert.deepEqual(types?.sort(), ["opened", "ready_for_review", "reopened", "synchronize"]);
  // Every pull_request_target event shares the per-PR group; any other comment gets a group of its
  // own, so it can never cancel a review.
  assert.match(workflow, /github\.event_name == 'pull_request_target'\s*\n\s*\|\|/);
  assert.match(workflow, /format\('claude-review-\{0\}', github\.event\.pull_request\.number \|\| github\.event\.issue\.number\)/);
  assert.match(workflow, /\|\| format\('noop-\{0\}', github\.run_id\)/);
  assert.match(workflow, /cancel-in-progress: true/);
});

test("write access is granted per job, and the head check is read-only", async () => {
  const workflow = await read(workflowPath);
  assert.match(workflow, /^permissions: \{\}$/m, "no workflow-wide token permissions");
  assert.deepEqual(permissions(job(workflow, "review")), { contents: "read", issues: "write", "pull-requests": "write" });
  const check = job(workflow, "head-check");
  assert.deepEqual(permissions(check), { contents: "read", issues: "read", "pull-requests": "read" });
  assert.match(check, /needs: review/);
  assert.doesNotMatch(check, /secrets\./, "the head check needs no secret");
  assert.match(check, /node \.github\/scripts\/claude-review-head-check\.mjs/);
});
