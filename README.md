# BountyDesk

Automated bug-bounty triage. A submitted report is authenticated, scope-checked, reproduced against a target the server pins, inside an isolated sandbox with a defender-authored **canary oracle**, and shipped as a verdict **only after a human approves the exact outbound comment**.

Built on the [TrueForge](https://trueforge.dev) agent harness for the WeMakeDevs × TrueFoundry × Qodo Agent Harness Hackathon.

> **Status: in progress.** Built today: the Postgres schema and durable jobs queue, signed
> GitHub App webhook intake with installation and repository lifecycle handling, GitHub OAuth
> login behind a reviewer allowlist, the worker that turns an accepted delivery into a durable
> report, and the Channels settings screen. Designed and not built: the sandboxes, the canary
> oracle, the approval gate, comment delivery, email and file-upload intake, and the dynamic
> per-repository target tier. Nothing below describes behaviour that runs today unless this
> paragraph says it does.


## Scope

Intake and reproduction are separate. A report enters through one of three independent
channels: GitHub issues, email, or file upload. Email and upload need no GitHub
connection. Reproduction is what requires a server-authorised target; a report without one is
triaged and stops at an evidence packet for a human.

The demo target is the owner's connected fork of Juice Shop at commit `1867b926`, the
`v17.3.0` tag. That source commit matches upstream. The existing scenarios were verified
against the upstream v17.3.0 image; the connected-fork image and snapshot do not exist yet and
must pass both scenarios before the demo can call them verified. The build happens ahead of
the run so live reproduction starts an immutable snapshot with no network.

The dynamic tier has the controller download a connected public repository at a
server-resolved commit and stage the hashed archive in a build sandbox. That sandbox gets
narrow dependency egress and no platform secrets. Reproduction uses the immutable output in a
second sandbox with no external egress. The tier is accepted, unbuilt, and gated on a
provisioning spike.

What never changes: a target with no defender-authored fixture and oracle cannot return a
reproduced verdict, whatever the proof-of-concept printed. It returns evidence and a human
decides.

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
- [#1, add CI and contribution standards](https://github.com/Vaibhav91one/bountydesk/pull/1). Qodo flagged the README and unpinned CI actions; both addressed in-thread.

Contribution rules: see [CONTRIBUTING.md](./CONTRIBUTING.md).

## AI assistance disclosure

This project was built with AI coding assistance under human direction. All changes are human-reviewed and merged through the Qodo-reviewed PR process above; security-sensitive logic (scope enforcement, the approval gate, delivery, GitHub App connectivity) carries tests and is reviewed before merge.
