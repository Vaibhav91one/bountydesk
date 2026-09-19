# PR Agent review runbook

This runbook tells an operator how to confirm that PR Agent actually reviewed the current head of a pull request. A green action run is not proof. Only a published review on the current commit counts, and even then it stays advisory.

Source files: `.github/workflows/pr-agent-review.yml`, `.pr_agent.toml`, `AGENTS.md`, `CONTRIBUTING.md`. Policy context comes from `AGENTS.md` and the Qodo history in `README.md`.

## What PR Agent is

PR Agent is an advisory reviewer. It posts model-generated suggestions on a PR. It is not a merge gate and not a security boundary.

What stays true while this action exists:

- `build` is the required automated check. PR Agent never replaces it.
- A human owns the merge decision. Each finding gets a fix or a reply that explains why it does not apply.
- No AI review result authorizes a verdict, target, approval, delivery, or merge.
- The action runs only on same-repo PRs. The workflow skips fork PRs through its head-repo guard, so a fork PR with no run is expected, not broken.
- The review policy loads from the default branch. A PR cannot change its own review policy through `AGENTS.md` edits on the branch.

## Current-head publication check

Run this check before treating any PR as reviewed. It takes about two minutes.

1. Record the current head SHA. Use `gh pr view <n> --json headRefOid --jq .headRefOid`.
2. List the action runs for the PR. Use `gh run list --workflow "PR Agent review" --limit 10`. Pick the run for the current head SHA. The workflow uses `pull_request_target`, so do not filter for `pull_request`.
3. Confirm that run concluded with success on the current SHA. A success on an older SHA does not count once new commits land, because the concurrency group cancels the older run in favor of the newer one.
4. Confirm publication on the PR itself. Open the PR conversation and look for the posted review or inline comments from the run. Logs without a posted review fail this step.
5. Confirm the posted review matches the current diff. Check that the review references the current head SHA or comments on lines that still exist in the current diff. A review that predates the latest push fails this step even when the action shows green.
6. If any step fails, the PR is not reviewed. Fix or retrigger within the retry limits below, then repeat the check from step 1.

## Canaries C0 to C5

These six checks make the publication check concrete. All six must pass. Each one names the evidence that proves it.

- C0, run exists: the PR checks list shows a `PR Agent review` run for the current head SHA. Evidence is the run id and the head SHA in `gh run view`.
- C1, run is fresh: the run started from the current head SHA and completed with a success conclusion. Evidence is the conclusion plus the SHA, not the workflow name alone.
- C2, output is published: the PR conversation shows the review body or inline comments posted by the run. Evidence is the comment URL. Green logs with no comment fail C2.
- C3, output matches the head: the published review names the current head SHA or covers the current diff. A review written against a parent commit fails C3 after a new push.
- C4, policy source is fixed: the run used `AGENTS.md` from the default branch with `repo_context_from_default_branch = true`, no repository-controlled skill paths (`[skills] enabled = false`), and no credentials from the branch. Evidence is `.pr_agent.toml` on the default branch.
- C5, secrets path is sane: the run read the model key from the `PR_AGENT_OPENAI_KEY` repo secret and used the ephemeral `GITHUB_TOKEN` for posting. No secret appears in logs, diffs, or comments. A run that needed a branch-supplied key fails C5.

## Failure categories

Match the symptom to a category before retrying. Retrying the wrong category wastes the retry budget.

- F1, secret or auth: missing or expired `PR_AGENT_OPENAI_KEY`, rejected key at the configured base URL (`https://vyceai.com/v1`), or `GITHUB_TOKEN` without permission to post. Logs point at 401, 403, or an auth error from the provider.
- F2, model or routing: unknown model name, token limit rejection, or tool error propagation halting the run. The pinned model is `openai/deepseek-v4.1` with `custom_model_max_tokens = 32000`. Logs point at model resolution, context length, or provider routing.
- F3, permissions or fork guard: the run never starts on a fork PR because the same-repo condition skips it, or posting fails on restricted permissions (`contents: read`, `issues: write`, `pull-requests: write`). No run for a fork PR is correct behavior.
- F4, trigger or concurrency: a push did not start a `/review` follow-up, an older run was cancelled in favor of a newer push, or the 10 minute job timeout fired. Logs show cancellation, supersede, or timeout.
- F5, unpublished output: the run is green but no review appears on the PR. Causes include `publish_output` disabled, a posting API failure, or the run reviewing a SHA that is no longer current.
- F6, stale head: the review exists but names an older SHA or comments on code the latest push removed. The fix is a fresh review of the current head, not a re-read of the old one.

## Retry limits

Retries are bounded. Two operator attempts per head SHA, then stop and hand the PR to human review.

- Attempt 1: re-run the failed PR Agent job with `gh run rerun <run-id> --failed`, then repeat the publication check.
- Attempt 2: close and reopen the PR to trigger a fresh `reopened` run, then repeat the publication check.
- The workflow does not listen for `issue_comment`, so `/review` comments do not trigger work.
- After two attempts, stop. Record the failure category and the run URLs in the PR thread and continue with human review plus `build`.
- Never loop retries in automation. Never push empty commits to force a review. A new push resets the budget because the head SHA changed, and the publication check starts over.
- A failed branch is a gap, not a pass. Do not mark the PR reviewed when the check is red.

## Secret rotation

The model key lives only as a repo secret. It never enters the tree, the workflow file, or `.pr_agent.toml`.

Rotation steps:

1. Create the replacement key at the provider.
2. Open the repository settings, then secrets, then Actions, and update `PR_AGENT_OPENAI_KEY` with the replacement value.
3. Open or update a test PR and run the publication check above. C5 passes when the run succeeds and no secret leaks into logs or comments.
4. Revoke the old key at the provider only after the test PR passes.
5. If rotation breaks reviews, classify as F1, use one retry on the test PR, and roll back to the prior key if the provider still honors it.

Notes that prevent common mistakes:

- `GITHUB_TOKEN` is ephemeral and needs no rotation. Keep its permissions at the least privilege set in the workflow.
- The GitHub App webhook secret is platform-owned and unrelated to this action. Do not rotate it from this runbook.
- Never print a key in an issue, PR comment, log, or script. If a secret leaks, revoke it at the provider first, then rotate.

## Qodo comparison boundaries

Qodo and PR Agent share a shape (model comments on a PR) but not a role. Keep the boundary explicit so history stays honest.

- Qodo was a required gate during the hackathon window, enforced through a `qodo-reviewed` check. That window closed when the trial expired in September 2026.
- PR Agent is advisory from day one. It has no required check, and `build` stays the required automated check.
- The Qodo-reviewed PR trail in `README.md` is history. Do not rewrite it, extend it with PR Agent results, or present PR Agent as its successor gate.
- Do not cite a PR Agent review as a security boundary for scope enforcement, intake authentication, delivery idempotency, or the approval gate. Those changes still land with tests and a threat note per `CONTRIBUTING.md`.
- When a PR description mentions review tooling, keep it factual and minimal, and name it only when a finding materially explains a code change.

## Operator commands

All commands assume `gh` is authenticated. Replace `<n>` with the PR number and `<run-id>` with the run id.

Check the current head:

```bash
gh pr view <n> --json number,headRefOid,headRefName --jq '{number, sha: .headRefOid, branch: .headRefName}'
```

List recent runs of the review workflow:

```bash
gh run list --workflow "PR Agent review" --limit 10
```

Inspect the run for the current SHA:

```bash
gh run view <run-id> --json conclusion,headSha,event,createdAt
```

List posted reviews and review comments on the PR:

```bash
gh api repos/{owner}/{repo}/pulls/<n>/reviews --jq '.[] | {id, state, commit_id, submitted_at}'
gh api repos/{owner}/{repo}/pulls/<n>/comments --jq '.[] | {id, commit_id, path, created_at}'
```

Re-run a failed job from the CLI (counts as attempt 1):

```bash
gh run rerun <run-id> --failed
```

Close and reopen the PR for attempt 2 through the GitHub UI, then verify the new run.

Verify the policy source on the default branch:

```bash
git show origin/main:.pr_agent.toml
```

Confirm this runbook is the only docs change under review when that is the intent:

```bash
git status --porcelain
git diff --check
```

Canary documentation change for PR-Agent publication verification.
