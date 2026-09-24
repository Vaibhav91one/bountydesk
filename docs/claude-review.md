# Claude review

The repository's advisory code review, run by Claude Code on Sonnet 5. It is not a merge gate: `build` stays the only required check, and no review result authorizes a verdict,
target, approval, delivery or merge. A human owns the merge decision and fixes a finding or answers
it in its thread.

## When it runs

- When a same-repository pull request is opened, reopened or marked ready for review.
- When the repository owner, a member or a collaborator comments `/review` on a pull request.

It does not run on every push, because it runs on the maintainer's Claude subscription through the
`CLAUDE_CODE_OAUTH_TOKEN` repository secret. Comment `/review` to review the latest head.

## What it posts

One inline comment per finding, on the line in question, and one summary comment that starts with
`<!-- claude-review head=<sha> -->`, then `## Code review` and either `No findings.` or a
collapsible block per finding. There are no tables, no emoji and no attribution line. At most eight
findings, rated High or Medium, and each must name the lines and a concrete way the code fails.

## Why it is safe to run with secrets

The workflow runs on `pull_request_target` and `issue_comment`, and both run the copy of
`.github/workflows/claude-review.yml` on the default branch. A pull request cannot change the
prompt, the tools or the review policy it is judged by.

- **Policy from the default branch.** The default branch is checked out at the workspace root, so
  the `AGENTS.md` and `CLAUDE.md` Claude reads are the trusted ones. The action also restores
  `.claude/` and `CLAUDE.md` from the base branch on pull requests.
- **The pull request is data.** Its head is checked out only into `pr-head/`, with credentials not
  persisted, and passed with `--add-dir`. The prompt tells Claude to ignore instructions found in it.
- **No code runs.** Claude has `Read`, `Grep`, `Glob`, the inline-comment tool, and `gh pr diff`,
  `gh pr view` and `gh pr comment`. It has no general shell, and file writes and web access are
  disallowed.
- **Who can trigger it.** Pull requests from forks are skipped, including when a `/review` comment
  names one. Comments count only from the owner, members and collaborators, and never from bots.
- **Pinned.** The action and both checkouts are pinned to full commit SHAs.

`.github/scripts/claude-review-policy.test.mjs` asserts each of these and runs in CI.

## History

PR-Agent (`gpt-4o-mini`) ran beside this review for a trial and was retired: it read only the diff,
and about one finding in twenty-five held up, while this review's findings were confirmed in the
code before they were posted. Its workflows, verifier and configuration are in the git history.
