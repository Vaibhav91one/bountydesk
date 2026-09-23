// Static checks for the trusted PR-Agent workflow boundary.
//
// These checks catch policy drift without contacting GitHub or the model provider.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

async function read(path) {
  return readFile(new URL(path, ROOT), "utf8");
}

test("review workflow runs trusted, same-repository API-only review", async () => {
  const workflow = await read(".github/workflows/pr-agent-review.yml");
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /head\.repo\.full_name\s*==\s*github\.repository/);
  assert.doesNotMatch(workflow, /actions\/checkout@/);
  assert.match(workflow, /The-PR-Agent\/pr-agent@[0-9a-f]{40}/);
  assert.match(workflow, /repo_context_from_default_branch: ['"]true['"]/);
  assert.match(workflow, /skills\.enabled: ['"]false['"]/);
  assert.match(workflow, /enable_auto_approval: ['"]false['"]/);
  assert.match(workflow, /persistent_finding_state: ['"]false['"]/);
  assert.match(workflow, /require_estimate_effort_to_review: ['"]false['"]/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(workflow, /auto_describe: ['"]true['"]/);
  assert.match(workflow, /auto_improve: ['"]true['"]/);
  assert.match(workflow, /push_commands: ['"]\[\"\/review\", \"\/describe\", \"\/improve\"\]['"]/);
  assert.match(workflow, /enable_pr_diagram: ['"]true['"]/);
  assert.match(workflow, /commitable_code_suggestions: ['"]true['"]/);
  assert.match(workflow, /OPENAI_KEY:\s*\$\{\{\s*secrets\.PR_AGENT_OPENAI_KEY\s*\}\}/);
  assert.doesNotMatch(workflow, /^\s+OPENAI\.API_BASE:/m);
});

test("verifier workflow resolves one exact head and uses read-only API access", async () => {
  const workflow = await read(".github/workflows/pr-agent-review-verify.yml");
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /pull-requests:\s*read/);
  assert.doesNotMatch(workflow, /issues:\s*write/);
  assert.doesNotMatch(workflow, /pull-requests:\s*write/);
  assert.match(workflow, /commits\/\$\{HEAD_SHA\}\/pulls/);
  assert.match(workflow, /test \"\$\(printf '%s\\n' \"\$numbers\" \| wc -l \| tr -d ' '\)\" = 1/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
});

test("provider policy stays pinned and advisory", async () => {
  const config = await read(".pr_agent.toml");
  assert.match(config, /model\s*=\s*"gpt-4o-mini"/);
  assert.match(config, /fallback_models\s*=\s*\[\]/);
  assert.match(config, /custom_model_max_tokens\s*=\s*32000/);
  assert.match(config, /enable_auto_approval\s*=\s*false/);
  assert.match(config, /repo_context_from_default_branch\s*=\s*true/);
  assert.match(config, /persistent_finding_state\s*=\s*false/);
  assert.match(config, /require_estimate_effort_to_review\s*=\s*false/);
  assert.match(config, /publish_output_no_suggestions\s*=\s*true/);
  assert.match(config, /persistent_comment\s*=\s*false/);
  assert.match(config, /num_max_findings\s*=\s*10/);
  assert.match(config, /Post inline review comments on every file touched/);
  assert.match(config, /Do not produce a summary section; findings live only as inline comments/);
  assert.match(config, /Never use markdown tables in review output/);
  assert.match(config, /severity tag/);
  assert.match(config, /Professional tone/);
  assert.match(config, /No emoji/);
  assert.match(config, /Match Qodo style/);
  assert.match(config, /review_heading = "Code Review"/);
  assert.doesNotMatch(config, /review_heading = "PR Reviewer Guide"/);
});

// CRITICAL: the workflow inlines config as env vars that override .pr_agent.toml.
// These assertions close the drift gap by checking that inlined values match the toml
// so a policy edit in one place surfaces as a test failure in the other.
test("workflow inlined config matches .pr_agent.toml", async () => {
  const workflow = await read(".github/workflows/pr-agent-review.yml");
  const toml = await read(".pr_agent.toml");
  const pairs = [
    ["persistent_comment", /pr_reviewer.persistent_comment: 'false'/, /persistent_comment\s*=\s*false/],
    ["num_max_findings", /num_max_findings: '10'/, /num_max_findings\s*=\s*10/],
    ["review_heading", /review_heading: 'Code Review'/, /review_heading\s*=\s*"Code Review"/],
    ["publish_output_no_suggestions", /publish_output_no_suggestions: 'true'/, /publish_output_no_suggestions\s*=\s*true/],
    ["enable_relevant_theory", /enable_relevant_theory: 'true'/, /enable_relevant_theory\s*=\s*true/],
    ["suggestion_preference", /suggestion_preference: 'diff'/, /suggestion_preference\s*=\s*"diff"/],
    ["pr_reviewer help text off", /pr_reviewer\.enable_help_text: 'false'/, /Tool usage guide" block is noise on every review\.\nenable_help_text\s*=\s*false/],
  ];
  for (const [label, wfRe, tomlRe] of pairs) {
    assert.match(workflow, wfRe, `workflow inlined ${label} should match`);
    assert.match(toml, tomlRe, `toml ${label} should match`);
  }
  assert.doesNotMatch(workflow, /review_heading: 'PR Reviewer Guide'/, "workflow must not carry old heading");
  assert.doesNotMatch(workflow, /persistent_comment: 'true'/, "workflow must not carry old persistent_comment value");
  assert.doesNotMatch(workflow, /num_max_findings: '3'/, "workflow must not carry old num_max_findings value");
});
