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

// Each claude-code-action step: the subscription review and its fallback.
const reviewSteps = (workflow) => workflow.split("uses: anthropics/claude-code-action@").slice(1).map((s) => s.split("- name:")[0]);

test("Claude gets read tools and gh pr only, never a shell or write access, on every review step", async () => {
  const workflow = await read(workflowPath);
  const steps = reviewSteps(workflow);
  assert.equal(steps.length, 2);
  for (const step of steps) {
    const allowed = step.match(/--allowedTools "([^"]+)"/)?.[1] ?? "";
    const tools = allowed.split(",");
    assert.ok(allowed.length > 0);
    for (const tool of tools) {
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
  }
  // The fallback must not drift into a looser prompt than the review it stands in for.
  const prompt = (step) => {
    const lines = step.split("prompt: |")[1].split("\n").slice(1);
    const end = lines.findIndex((line) => line.trim() !== "" && !line.startsWith(" ".repeat(12)));
    return lines.slice(0, end === -1 ? undefined : end).join("\n").trim();
  };
  assert.ok(prompt(steps[0]).includes("<!-- claude-review head="));
  assert.equal(prompt(steps[1]), prompt(steps[0]));
});

test("credentials are referenced from secrets, never inlined", async () => {
  const workflow = await read(workflowPath);
  const [primary, fallback] = reviewSteps(workflow);
  assert.match(primary, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
  assert.doesNotMatch(primary, /anthropic_api_key:/);
  // The only API key is VyceAI's, and it goes only to VyceAI's endpoint.
  assert.match(fallback, /anthropic_api_key: \$\{\{ secrets\.VYCEAI_API_KEY \}\}/);
  assert.equal((workflow.match(/anthropic_api_key:/g) ?? []).length, 1);
  assert.match(workflow, /ANTHROPIC_BASE_URL: https:\/\/vyceai\.com\n/);
  assert.doesNotMatch(workflow, /sk-ant-|oauth_token_|sk-[A-Za-z0-9]{20}/);
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
