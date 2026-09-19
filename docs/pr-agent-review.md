# PR Agent review runbook

This runbook tells an operator how to confirm that PR Agent actually reviewed the current head of a pull request. A green action run is not proof. Only a published review on the current commit counts, and even then it stays advisory.

Source files: `.github/workflows/pr-agent-review.yml`, `.github/workflows/pr-agent-review-verify.yml`, `.github/scripts/verify-pr-agent-review.mjs`, `.github/scripts/verify-pr-agent-review.test.mjs`, `.pr_agent.toml`, `AGENTS.md`, `CONTRIBUTING.md`. Policy context comes from `AGENTS.md` and the Qodo history in `README.md`.

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
4. Confirm publication on the PR itself. Open the PR conversation and look for one of the two accepted forms. A formal review whose `commit_id` equals the current head SHA, or a persistent comment that carries the canonical marker `<!-- pr-agent:review:full -->` and was published after the verified run started. Inline diff comments alone fail this step, and logs without a posted review fail this step.
5. Confirm the binding matches the current head. A formal review counts only when its `commit_id` equals the current head SHA. A canonical comment counts only when its timestamp is at or after the run start. A review that predates the latest push fails this step even when the action shows green.
6. If any step fails, the PR is not reviewed. Fix or retrigger within the retry policy below, then repeat the check from step 1.

## Canaries C0 to C5

These six checks make the publication check concrete. All six must pass. Each one names the evidence that proves it.

- C0, run exists: the PR checks list shows a `PR Agent review` run for the current head SHA. Evidence is the run id and the head SHA in `gh run view`.
- C1, run is fresh: the run started from the current head SHA and completed with a success conclusion. Evidence is the conclusion plus the SHA, not the workflow name alone.
- C2, output is published: the PR conversation shows a formal review or a canonical persistent comment with PR-Agent body text (`pr-agent` or `PR Reviewer Guide`) from an approved publisher (`github-actions[bot]`, `pr-agent[bot]`, or `pr-agent`). Evidence is the comment URL. Green logs with no such publication fail C2. Inline diff comments alone fail C2.
- C3, output matches the head: the formal review `commit_id` equals the current head SHA, or the canonical comment timestamp is at or after the verified run start. A review written against a parent commit fails C3 after a new push. Legacy head markers (`pr-agent-review head=<sha>`) are diagnostic only and fail C3 on their own.
- C4, policy source is fixed: the run used `AGENTS.md` from the default branch with `repo_context_from_default_branch = true`, no repository-controlled skill paths (`[skills] enabled = false`), and no credentials from the branch. Evidence is `.pr_agent.toml` on the default branch.
- C5, secrets path is sane: the run read the model key from the `PR_AGENT_OPENAI_KEY` repo secret and used the ephemeral `GITHUB_TOKEN` for posting. No secret appears in logs, diffs, or comments. A run that needed a branch-supplied key fails C5.

## What counts as publication

The verifier accepts two forms, and nothing else counts.

- A formal review counts when its body carries PR-Agent text, its publisher is approved, its state is not dismissed, and its `commit_id` is the full 40 character head SHA of the current head.
- A persistent comment counts when its body carries PR-Agent text, its publisher is approved, it contains the canonical marker `<!-- pr-agent:review:full -->` (matched without regard to case or extra spacing), and its updated timestamp is at or after the verified run start. The run start comes from the workflow run `created_at` or `run_started_at` field.
- Legacy head markers in the shape `pr-agent-review head=<sha>` do not verify on their own. A truncated marker reports `MALFORMED_MARKER`. A marker that names an older head reports `STALE_HEAD`. Text without either binding reports `STANDALONE_ONLY`.
- Inline diff comments alone never verify because they carry no head binding. A dismissed formal review never verifies because dismissed means retracted. Text from a publisher outside the approved set never verifies.
- Failure text poisons the verdict even when a binding is present. Any candidate that reports a parse failure or a publication failure keeps the result at `UNVERIFIED`. An explicit clean bill of health (`no major issues`, `looks good to me`, `lgtm`, `all clear`, and the nearby variants in the verifier) reports `NO_FINDINGS` instead of `VERIFIED`.

## Failure categories

Match the symptom to a category before retrying. Retrying the wrong category wastes the retry budget.

- F1, secret or auth: missing or expired `PR_AGENT_OPENAI_KEY`, rejected key at the configured base URL (`https://vyceai.com/v1`), or `GITHUB_TOKEN` without permission to post. Logs point at 401, 403, or an auth error from the provider.
- F2, model or routing: unknown model name, token limit rejection, or tool error propagation halting the run. The pinned model is `openai/deepseek-v4.1` with `custom_model_max_tokens = 32000`. Logs point at model resolution, context length, or provider routing.
- F3, permissions or fork guard: the run never starts on a fork PR because the same-repo condition skips it, or posting fails on restricted permissions (`contents: read`, `issues: write`, `pull-requests: write`). No run for a fork PR is correct behavior.
- F4, trigger or concurrency: a push did not start a `/review` follow-up, an older run was cancelled in favor of a newer push, or the 10 minute job timeout fired. Logs show cancellation, supersede, or timeout.
- F5, unpublished output: the run is green but no review appears on the PR. Causes include `publish_output` disabled, a posting API failure, or the run reviewing a SHA that is no longer current.
- F6, stale head: the review exists but names an older SHA or comments on code the latest push removed. The fix is a fresh review of the current head, not a re-read of the old one.

## Retry policy

Two retry budgets apply, and they cover different layers. Do not mix them.

The verifier retries only flaky reads. It makes up to three attempts with a 250 millisecond base delay, and it retries only rate limits (429), server errors (500 and above), or network errors with no status. A 404 or other client error fails at once. A persistent failure surfaces as `UNVERIFIED` instead of hanging the job. This budget covers GitHub API reads inside the check, not the model run itself.

Operator retries are bounded. Two operator attempts per head SHA, then stop and hand the PR to human review.

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

## Acceptance criteria

These are the production boundaries, not a second merge gate:

- Merge acceptance is a pull request, a green `build` check, and resolved conversations. The `PR Agent review` and `Verify PR Agent review` workflows are never required status checks.
- A same-repository PR is PR-Agent reviewed only when the current-head check returns `VERIFIED` or `NO_FINDINGS`. A green action without a published, current-head review is not enough.
- Fork PRs intentionally skip the provider-backed workflow. Treat `SKIPPED/FORK_UNSUPPORTED` as expected, not as failed review evidence.
- A provider, model, parse, or publication failure remains unverified. After the two attempts allowed for one head SHA, human review plus the green `build` check can complete a merge, but the PR must not be called PR-Agent verified.
- Qodo's `qodo-reviewed` check was the required hackathon gate until the trial expired in September 2026. PR Agent did not replace that gate. The Qodo table in `README.md` is frozen history and must not be extended with PR-Agent results.

Deterministic checks and live reviews answer different questions. The offline verifier tests (`node --test .github/scripts/verify-pr-agent-review.test.mjs`, run as an explicit step in `.github/workflows/ci.yml`) prove parser and publication decisions against fixtures. They pass without network, credentials, or a live model run. They do not prove that the external provider is reachable or that a live PR-Agent run has published a review. A live review needs a successful `PR Agent review` run on the current head SHA plus a publication that passes C0 to C5. Record the deterministic CI result separately from the live provider, workflow, and canary evidence for the head under review.

Live review has a provider and data approval prerequisite. The approved provider binding is the pinned action (`The-PR-Agent/pr-agent` at `v0.45.0`), the base URL (`https://vyceai.com/v1`), the model (`openai/deepseek-v4.1`), and the token limit (`custom_model_max_tokens = 32000`). The approved data binding is `AGENTS.md` from the default branch (`repo_context_from_default_branch = true`, 500 lines max) with repository-controlled skills off and no branch-supplied credentials. A run on a different provider, model, base URL, or data source does not count as reviewed until a human approves that binding and records it. The key itself stays a repo secret and never enters the tree.

## Current limitations

These limits hold until a later change removes them, with tests and review.

- Fork PRs receive no provider-backed review. The workflow skips them by design, and the verifier reports `SKIPPED` before it reads review evidence.
- The check is per head SHA. Any push resets it. A run for an older SHA, a review bound to an older commit, or a canonical comment from before the run start does not carry over.
- Run identity is strict. The run name must be `PR Agent review`, the conclusion must be success, the run head must equal the PR head, the run must belong to the same repository, and a run linked to more than one PR does not verify. An empty link list is allowed only because the link field is ephemeral after close.
- Publication is narrow. Formal reviews need a full head SHA binding. Canonical comments need the canonical marker plus a timestamp at or after run start. Inline-only text, legacy markers alone, dismissed reviews, and untrusted publishers never verify.
- Concurrency cancels older runs. A push while a review is running supersedes it, and the 10 minute job timeout can end a slow model call. Both cases need a fresh run for the current head.
- The workflow answers only to `opened`, `synchronize`, and `reopened`. Comment commands and manual API calls do not start a review, and the verifier workflow answers only to a completed review run.
- The verifier never authorizes a merge. `VERIFIED` means a review was published for the head, `NO_FINDINGS` means that review declares a clean bill of health, and both still need human reading plus a green `build`.

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

## PR Agent DeepSeek canary

Exercise DeepSeek provider configuration after merge.
