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
  assert.match(workflow, /auto_describe: ['"]false['"]/);
  assert.match(workflow, /auto_improve: ['"]false['"]/);
  assert.match(workflow, /persistent_finding_state: ['"]false['"]/);
  assert.match(workflow, /require_estimate_effort_to_review: ['"]false['"]/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(workflow, /OPENAI_KEY:\s*\$\{\{\s*secrets\.PR_AGENT_OPENAI_KEY\s*\}\}/);
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
  assert.match(config, /model\s*=\s*"openai\/gpt-5\.6-luna"/);
  assert.match(config, /fallback_models\s*=\s*\[\]/);
  assert.match(config, /custom_model_max_tokens\s*=\s*32000/);
  assert.match(config, /enable_auto_approval\s*=\s*false/);
  assert.match(config, /repo_context_from_default_branch\s*=\s*true/);
  assert.match(config, /persistent_finding_state\s*=\s*false/);
  assert.match(config, /require_estimate_effort_to_review\s*=\s*false/);
});
