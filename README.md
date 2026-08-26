# BountyDesk

Automated bug-bounty triage. A submitted report is authenticated, scope-checked, reproduced against a pinned target inside an isolated sandbox with a defender-authored **canary oracle**, and shipped as a verdict **only after a human approves the exact outbound comment**.

Built on the [TrueForge](https://trueforge.dev) agent harness for the WeMakeDevs × TrueFoundry × Qodo Agent Harness Hackathon.

> **Status: building, phase by phase.** Done so far: the Postgres schema and the durable jobs
> queue, signed GitHub App webhook intake with installation and repository lifecycle handling,
> and GitHub OAuth login behind a reviewer allowlist. Not built yet: the sandbox and canary
> oracle, the approval gate, comment delivery, and the operator UI. The pipeline described
> below is the target MVP, not a description of what runs today.


## Frozen MVP

GitHub Issue intake → one pinned Juice Shop target → two frozen scenarios (search UNION SQLi, login auth-bypass) → human-approved GitHub comment. Everything else is roadmap.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Qodo Code Review Evidence

Every substantive change lands through a GitHub pull request reviewed by [Qodo Merge](https://github.com/apps/qodo-merge-pro) before merge. Direct pushes to `main` are blocked by branch protection. For each PR, Qodo's automated review, our responses (fixes or reasoned dismissals), and any follow-up review are visible in the PR thread.

Representative reviewed PRs:

- [#4, signed GitHub App webhook and installation lifecycle](https://github.com/Vaibhav91one/bountydesk/pull/4). Qodo's first pass found five issues in the intake path, two of them High. A redelivered `installation.created` could clear `deleted_at` and hand back access an uninstall had taken away, and the access check ran in a separate statement from the enqueue, so a suspension could commit between the two and the job was created anyway. Both are fixed: lifecycle deliveries are now deduplicated in the same transaction as the mutation they apply, and intake holds the access check and the enqueue in one transaction with a `FOR SHARE` lock on the rows it read. A follow-up review covered the fixes, and the two orderings are pinned by concurrent-connection tests.
- [#1, Phase 0 scaffold: CI, contribution rules, Qodo evidence trail](https://github.com/Vaibhav91one/bountydesk/pull/1). Qodo flagged the README and unpinned CI actions; both addressed in-thread.

Contribution rules: see [CONTRIBUTING.md](./CONTRIBUTING.md).

## AI assistance disclosure

This project was built with AI coding assistance under human direction. All changes are human-reviewed and merged through the Qodo-reviewed PR process above; security-sensitive logic (scope enforcement, the approval gate, delivery, GitHub App connectivity) carries tests and is reviewed before merge.
