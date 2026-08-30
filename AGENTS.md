# BountyDesk agent guide

Automated bug-bounty triage. A report is authenticated, scope-checked, and investigated by a
TrueForge agent against a pinned target in an isolated sandbox, and shipped as a verdict only
after a human approves the agent's exact drafted comment. Built on the TrueForge agent harness.

This file is the single source of project instructions. `CLAUDE.md` only does `@AGENTS.md`, so
keep everything here.

## Architecture invariants (do not violate)

The verdict is the agent's own conclusion, not a pre-computed answer it relays. The TrueForge
agent investigates a report against its authorised target using scope-guard, a sandbox, skills
and subagents, then drafts its own outcome, summary and findings by calling `publish_verdict`.
Nothing is delivered until a human approves the exact drafted text.

What stays fixed: the capability boundary decides which target and which tool authorisations
the agent can reach, not what it is permitted to conclude. A claimed `REPRODUCED` or
`NOT_REPRODUCED` for a report with no bound target, or one whose repository grant has since
been revoked, is refused server-side before it ever becomes a verdict row, regardless of what
the agent asserts.

No bound target, no `REPRODUCED`. A report with no authorised target, or one whose repository
grant has since been revoked, cannot produce a reproduced or not-reproduced verdict, whatever
the agent's own investigation concluded; that run stays `ANALYSIS_ONLY` and a human decides. The
defender-authored canary/fixture/negative-control pipeline is retained as a strictly stronger
evidence source, not the sole gate on `REPRODUCED` (see `docs/decisions.md` Q22).

A sandbox status file reports target readiness only. It is sandbox-controlled evidence and can
never determine reproduction, severity or outbound content. `READY` means the target started
and answered its health check; `FAILED` means startup failed. Nothing else.

The human gate is never skippable. `publish_verdict` is approval-gated, and the tool refuses
any payload whose content hash differs from the approved one. Nothing is ever auto-closed:
semantically similar reports go to a human as top-k candidates, and only exact delivery
replays are automatic no-ops.

Intake and reproduction are separate. A report enters through one of three independent
channels: GitHub issues, email, or file upload. Email and upload need no GitHub connection to
create and triage a report. Reproduction is what needs a server-authorised `TargetProfile`, and
a report without one stops at `ANALYSIS_ONLY` with nothing cloned, built, deployed or probed.

Connectivity is the GitHub App model, not manual webhooks. OAuth login is identity, the App
install is repo access. Least privilege is Metadata read plus Issues read and write. Cloning a
connected repository does not widen that: a public repository clones anonymously, and Contents
read would be needed only for a private one. The intended private-repository policy accepts and
triages the signed issue, then refuses reproduction with `POLICY_REFUSED` until that permission
is deliberately added and accepted. This is not built: current GitHub intake requires a bound
target profile, and repository visibility is not stored. The webhook secret belongs to the
platform, and `installation_id → repo → TargetProfile` resolves server-side. Mint short-lived
installation tokens per delivery and discard them. Keep access in sync from the `installation`,
`installation_repositories`, and `repository` lifecycle webhooks: a suspended or deleted
installation, or a removed repository, must stop intake and delivery at once.

Job execution and report lifecycle are separate enums. Job execution runs
`RECEIVED → PARSED → SESSION_CREATED → RUNNING → DONE | DEAD_LETTER`. Leasing (`lease_owner`,
`lease_expires_at`, `attempts`, `fence`) is orthogonal to that, not a state of its own. The
frozen MVP report enum is `TRIAGING | REPRODUCING | ANALYSIS_ONLY | AWAITING_APPROVAL |
DELIVERING | DELIVERED | DENIED | OUT_OF_SCOPE | CANCELLED | EXPIRED`, and the last five are
terminal. `AWAITING_REPORTER` is a post-MVP extension, non-terminal, and must not be emitted
until reporter-reply correlation ships. `DEAD_LETTER` belongs to job execution only.

The durable jobs table is the queue. Idempotency is the unique `(channel, delivery_id)`, and
the decision is made on state rather than on whether the row exists. Insert `RECEIVED`, return
202 quickly, let the worker drive the states, and let the sweeper reclaim expired leases.

Scope is bound at the capability boundary, never from a string the agent produced. Clone,
deploy, and egress all take the target from the server-held `TargetProfile`.

Secrets stay server-side. The browser talks only to Next.js, and SSE is proxied server-side on
the Node runtime rather than edge. TrueForge stays on loopback or a private network, never
public.

## Stack

Next.js on the App Router with TypeScript, using npm. This is a modified Next.js, so read the
block at the end of this file.

Postgres on the Supabase free tier with Drizzle ORM. Not SQLite: the app fronts on Vercel,
which has no persistent disk, and the jobs-table lease needs `SELECT … FOR UPDATE SKIP LOCKED`,
a real row lock. `drizzle-kit` handles migrations.

The TrueForge harness runs on `http://localhost:8790` over loopback, with OpenAI as the
first-class model provider. The scope-guard MCP server is ported from the Sentinel prototype.
Daytona provides the sandboxes and BountyDesk provisions them directly; TrueForge exposes no
image or snapshot field, so it stays the agent harness. A dynamic run uses two, a build sandbox
with narrow dependency egress and a reproduction sandbox with none, and only the built artifact
crosses between them. The build sandbox is not trusted: it runs the customer's code. The demo
target is the connected fork `Vaibhav91one/juice-shop` at commit
`1867b926c5f50e4e692dc9c8f61821413cebe0cd`, the `v17.3.0` tag. It must be built and verified
ahead of the live run so reproduction can start an immutable snapshot offline. The pinned
target's snapshot is built and verified, and the sandbox pipeline has run live end to end
against it; see `docs/decisions.md`'s implementation gates and `docs/plan.md`'s Phase 4 and
Phase 5 status notes for what is proven and what is still open.

## Env

Copy `env.example` to `.env.local`, which is gitignored, and fill it in. Only the DATABASE
block is needed to run anything: `DATABASE_URL` for the app (transaction pooler, port 6543)
and `DIRECT_URL` for migrations (port 5432). Never commit real secrets. `env.example` holds
placeholders only.

## Working rules

Every substantive change ships through a Qodo-reviewed PR. Branch protection enforces this:
`main` requires a PR, the `build` and `qodo-reviewed` checks, and resolved conversations, with
admins included. A direct push does not produce the required review record, and that record
cannot be backfilled.

Security-sensitive changes land with a test. That means the scope guard, the canary oracle,
intake authentication, delivery idempotency, and the approval gate. CI must be green before a
merge.

Reuse from the Sentinel prototype where the plan says to: the scope-guard engine and its
tests, CI, CONTRIBUTING, and the TrueForge session and turn driver. Do not rebuild what is
already there.

Disclose AI assistance in the PR.

## Writing style

Everything you write in prose goes through the `humanizer` skill: code comments, commit
messages, PR descriptions, and anything under `docs/`. Load it before writing, not after. The
goal is text that reads like a person wrote it, because a reviewer has to trust this code, and
prose that sounds generated invites skimming instead of reading.

The rules that come up most often here:

Say what a thing is. "The oracle runs outside the sandbox", not "the oracle serves as the
component that runs outside the sandbox". Use `is` and `has` rather than `serves as`,
`represents`, or `boasts`.

No em dashes or en dashes. Use a comma, a colon, parentheses, or a full stop. Arrows in state
diagrams and code are notation, not punctuation, and are fine.

No decorative formatting. Skip emoji, skip bolded mini-headings in lists, and write headings
in sentence case rather than Title Case. Bold is for the rare word that genuinely needs
weight.

Comments explain why, not what. The code already says what it does. A comment earns its place
by recording the reason, the constraint, or the trap that is not visible in the lines below
it. `// increment the counter` is noise. `// claim() is global-FIFO, so a test that seeds then
claims can be handed an earlier test's row` is worth the space.

Comments describe how the code behaves now, not how it used to. Anything about a previous
version belongs in the commit message, which is the document about change.

Cut filler and stacked hedges. "To achieve this", not "in order to achieve this goal". If a
claim is uncertain, say so once.

End on the last real point. No summary paragraph that restates what was just said, and no
closing line about how solid the foundation now is.

## Git workflow

How this repo is run, and what is already set up.

`main` is protected, and this is enforced rather than a convention. A PR is required, the
`build` and `qodo-reviewed` checks must pass, every conversation must be resolved, admins are
included through `enforce_admins`, and force-pushes and branch deletion are off. A direct push
is rejected with `GH006 … Changes must be made through a pull request`.

The loop for every change: branch off `main`, commit, push, open a PR, let the Qodo Code
Review App review it, address each finding in the thread with either a fix or a reasoned
dismissal, wait for green checks, then `gh pr merge <n> --squash --delete-branch`. Qodo
submits a formal review on its first pass and edits that same comment on later pushes, so the
`qodo-reviewed` check accepts either signal and waits for it rather than failing on timing.

Do not open a standalone PR for each trivial edit. Keep small, related changes on a scoped
branch until they form one coherent, reviewable improvement, then open a single PR for that
work. Do not bundle unrelated changes to make a PR look larger, and do not use this rule to
push directly to `main`.

The Qodo review trail has a few additional requirements:

- If Qodo does not start automatically, comment `/agentic_review` on the PR.
- Fix every valid High-severity finding before merge. Dismiss a finding only with a reasoned
  response in its thread.
- After pushing fixes to the same PR, run `/agentic_review` again when needed. Confirm that
  Qodo reviewed the current head commit, not only an earlier revision.
- Keep the exact `## Qodo Code Review Evidence` heading in `README.md`. It must link to at
  least one representative merged PR with meaningful project code, explain in one or two
  lines what Qodo found and what was fixed or intentionally dismissed, and leave the initial
  and follow-up reviews visible in that PR's history.

Qodo Agent Skills are an optional helper for resolving findings. Install them with
`npx skills add qodo-ai/qodo-skills/skills`, then use `qodo-pr-resolver`. The skill does not
replace the required Qodo review, follow-up review, green checks, or resolved conversations.

Every PR description uses this template. Replace the placeholder text, check every applicable
type of change, and leave unrelated boxes unchecked.

Write the description as a natural engineering record of the change. Keep it focused on what
the PR changes, why the change is needed, and how it was verified. Do not frame a PR around an
event, competition, eligibility requirement, development phase, or the act of creating a PR.
Mention a review tool only when its finding materially explains a code change. Avoid ceremony,
promotional language, and process commentary that does not help a reviewer judge the patch.

```markdown
## Description
- Provide a brief summary of the changes and why they are needed.

## Type of change
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Code style update (formatting, local variables)
- [ ] Refactoring (no functional changes, no api changes)
- [ ] Documentation update

## Related tickets & issues
- Fixes #[Issue Number] / JIRA-[ID]

## How has this been tested?
- Describe the tests you ran to verify your changes.
- Provide instructions so reviewers can reproduce.

## Checklist
- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code where necessary
- [ ] I have updated the documentation accordingly
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
```

Branch names are `feat/…`, `fix/…`, `chore/…`, `docs/…`. Commit trailer is
`Co-Authored-By: Claude <noreply@anthropic.com>`.

Stage only what your change owns. The shadcn UI scaffold is deliberately left uncommitted in
the working tree (`app/globals.css`, `app/layout.tsx`, `components.json`, `lib/utils.ts`,
`.claude/`). Never sweep it into an unrelated PR; it lands with the UI phase. Add the specific
files you touched, and never run `git add -A` on this tree.

Secrets never get committed. `.env.local` is gitignored, and `env.example` holds placeholders
only.

## Subagents run isolated, with their own worktree and backend

Any subagent that edits files or touches the database runs in its own git worktree with its
own backend, never the primary checkout. No shared branch, no shared database, no overlap.

Own worktree. Prefer the Agent tool's `isolation: "worktree"`, which runs the agent on an
isolated copy and removes it again if nothing changed. By hand it is
`git worktree add ../bd-<task> -b <task-branch>`, cleaned up with `git worktree remove` once
the PR merges. Each worktree opens its own PR, and merges still serialize through Qodo and CI
on `main`.

Own database. Give each agent a distinct `DATABASE_URL` so one agent's migrations and jobs
rows cannot collide with another's. The cheapest isolation is a throwaway local Postgres per
agent (`docker run -e POSTGRES_PASSWORD=… -p <unique-port>:5432 postgres`), or a dedicated
schema in a shared database. Put the override in that worktree's own `.env.local` and run
`drizzle-kit` there, never against the shared Supabase project.

Own ports. Give each agent unique local ports for the app, TrueForge, and scope-guard through
`APP_BASE_URL`, `TRUEFORGE_URL`, and `SCOPE_GUARD_URL`, so two agents' services do not fight
over a socket.

Read-only subagents that only search, review, or analyse do not need a worktree. Isolation is
for agents that mutate files or state.

## Database notes worth knowing before you touch it

The Supabase Data API is closed. Migration `0001_lockdown.sql` revokes all privileges on
`public` from `anon` and `authenticated`, revokes the default privileges so later tables
inherit the lockout, and enables RLS on every table with no policies, which denies by default.
The app connects as `postgres`, which has `BYPASSRLS`, so none of this affects it. If you add
a table, it is locked down automatically. Do not grant it to `anon` to make something work.

Four tables refuse UPDATE and DELETE at the database level through triggers: `verdict`,
`approval_decision`, `session_event`, and `delivery_attempt`. This is deliberate, and it means
you cannot clean up test rows in those tables. Any test that writes to them must use the
disposable-schema pattern in `lib/jobs/queue.test.ts`, which creates a schema, replays the
committed migrations into it, and drops it afterwards.

A verdict is revised by inserting the next revision, not by editing the row, which is why
`(report_id, revision)` is unique. `outbound_delivery` deliberately has no `body` column: the
delivery worker reads the immutable `verdict.payload` and checks it against
`approved_content_hash` at send time. A second mutable copy of the comment would let a human
approve one text while GitHub receives another.

## Design record

The committed source of truth is [`docs/decisions.md`](docs/decisions.md) covering Q1 to Q21,
[`docs/demo-runbook.md`](docs/demo-runbook.md), and [`docs/plan.md`](docs/plan.md). When this
summary is ambiguous, defer to those records and ask rather than guess.

## Figma design files

Two Figma files hold the visual design and the technical flow diagrams. If you have Figma
access, open them by file key. Both are named below so you can confirm you are in the right
one. Design files use the `/design/` path and FigJam boards use `/board/`.

BountyDesk UI, a design file, key `eEs4G9lPqF9M0IGGBzy1Cd`.
<https://www.figma.com/design/eEs4G9lPqF9M0IGGBzy1Cd/BountyDesk-UI>
Pages, with node ids verified on 2026-08-26 through the Plugin API:

- Sitemap `43:2`, the route and screen map for public, app, settings and admin surfaces.
- Logo `43:3`, the "Trix the Triage Guardian" mascot and its animation states.
- Wireframes `43:4`, grayscale low-fidelity layouts: Login, Review Queue, Reports, Case File
  ("Sign the verdict"), Channels (the GitHub App install card), and Scope.
- Screens `43:5`, higher-fidelity screens.
- Design System, Dark Colors `153:2`, the dark palette.

One trap: `get_metadata` may list only the page that is currently open, because Figma loads
pages lazily. That is not evidence a page is missing. To enumerate pages reliably use
`use_figma` with `figma.root.children`, and call `await figma.setCurrentPageAsync(page)` before
reading a page's contents.

BountyDesk board, a FigJam board, key `K6z2IqS3ep6EtlriSWp8CE`.
<https://www.figma.com/board/K6z2IqS3ep6EtlriSWp8CE/BountyDesk>
Pages:

- Flow diagrams, the end-to-end technical flow from intake through triage, sandbox and canary
  oracle, approval, and delivery, on the GitHub App model.
- Threat model, the attack chains and the honest account of sandbox isolation.
- UML, the data and domain model.
- Development Plan, the phase-by-phase build plan as parallel swimlanes, from the Day-0 gate
  through tracks A to D and back to converge. Deep link verified on 2026-08-26:
  <https://www.figma.com/board/K6z2IqS3ep6EtlriSWp8CE/BountyDesk?node-id=129-418>

The Figma files are design reference, not a build dependency. Treat `docs/` as the authority
for any decision. In particular the Development Plan canvas still carries an older job and
report state model, so implement the frozen enums in `docs/decisions.md` and `docs/plan.md`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
