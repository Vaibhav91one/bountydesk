# Retest suggestion on default-branch polling

## What it does

The reconcile tick polls the public GitHub REST API for the default branch head of every
connected repository that has at least one REPRODUCED report. When that head differs from
the report's pinned commit and no retest exists yet, the case file shows a one-click
retest suggestion.

The suggestion text reads:

> New commit <short sha> on <branch>. Retest at this commit?

Clicking **Start retest** calls the existing `startRetest` with the full commit SHA. The
retest then runs as a normal child report through the upload path.

## What it does NOT do

Polling never starts a retest automatically. The button requires a human click. This keeps
a poll from spending sandbox credits by itself. The trigger stores only a commit SHA and
branch name; no secrets are involved.

## What the App needs

No App subscription or Contents read is required. The reconcile tick reads the default
branch head unauthenticated from the public GitHub commits endpoint
(`GET /repos/{owner}/{repo}/commits/{default_branch}` with `Accept: application/vnd.github.sha`).
GitHub's unauthenticated rate limit (60 requests/hour) is ample for the small set of
public repositories that have REPRODUCED reports.

Polling updates the `latest_pushed_commit_sha` and `latest_pushed_branch` columns on
`connected_repository`. The suggestion logic in `readPushSuggestion`
(`lib/retests/push-suggestion.ts`) decides whether to surface one:

- The report must have a live verdict of `REPRODUCED`.
- The report must be in `DELIVERING` or `DELIVERED` state.
- The bound repository must be connected to a live, unsuspended installation.
- The polled SHA must differ from the target profile's `resolved_commit_sha`.
- No retest row may already exist for that verdict and commit.

## Why not a push webhook

Our GitHub App holds Contents read only for installations that opted into private repo
reproduction. A push webhook would only fire for those installations, missing the much
larger set of public repositories. Polling the public commits endpoint avoids that gap
entirely, and no App permission change is needed.

## Private repositories

Private repositories are excluded. An unauthenticated public SHA fetch is all this path
needs, and private repos have no grant-free read. A private repo that later opts into
Contents read is still excluded: the retest itself runs through the upload path, which
cannot hold an installation token for a private clone (same `POLICY_REFUSED` as private
reproduction itself). See Q34's as-built section in `docs/decisions.md`.

## Latency

The suggestion appears within one reconcile interval of a push landing on the default
branch. The reconcile tick runs on a fixed schedule (see `GITHUB_RECONCILE_INTERVAL_MS`
in `scripts/run-worker-daemon.ts`); polling never blocks reconcile's access-revocation
work.

## Idempotency and errors

Each repository is fetched at most once per tick. On any fetch error (rate limit, 5xx,
network), the old `latest_pushed_commit_sha` value is left untouched: a failed poll never
clears a suggestion that was already shown.

## Files

- `lib/github/reconcile.ts`: `reconcilePushSuggestions` polls default-branch heads and
  stores the SHA and branch on `connected_repository`.
- `lib/retests/push-suggestion.ts`: `readPushSuggestion` returns the suggestion or null.
- `app/(app)/reports/[id]/retest-panel.tsx`: renders the suggestion as a one-click button.
- `app/(app)/reports/[id]/page.tsx`: calls `readPushSuggestion` and passes it to the panel.
- `scripts/run-worker-daemon.ts`: calls `reconcilePushSuggestions` after
  `reconcileGitHubAccess` on each reconcile tick.
- `drizzle/0056_retest_push_suggestion.sql`: adds `latest_pushed_commit_sha` and
  `latest_pushed_branch` to `connected_repository`.
