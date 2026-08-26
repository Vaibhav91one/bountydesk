# BountyDesk

Automated bug-bounty triage. A submitted report is authenticated, scope-checked, reproduced against a pinned target inside an isolated sandbox with a defender-authored **canary oracle**, and shipped as a verdict **only after a human approves the exact outbound comment**.

Built on the [TrueForge](https://trueforge.dev) agent harness for the WeMakeDevs × TrueFoundry × Qodo Agent Harness Hackathon.

> **Status: scaffold.** This repo currently holds the Phase 0 project scaffold (CI, contribution rules, Qodo review trail). The pipeline described below is the target MVP and is being built phase by phase, and is not yet implemented.


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
- [#1, Phase 0 scaffold: CI, contribution rules, Qodo evidence trail](https://github.com/Vaibhav91one/bountydesk/pull/1) (Qodo flagged README/CI-pinning; both addressed in-thread)

Contribution rules: see [CONTRIBUTING.md](./CONTRIBUTING.md).

## AI assistance disclosure

This project was built with AI coding assistance under human direction. All changes are human-reviewed and merged through the Qodo-reviewed PR process above; security-sensitive logic (scope enforcement, the approval gate, delivery, GitHub App connectivity) carries tests and is reviewed before merge.
