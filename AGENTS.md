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
terminal. There is no reporter-reply state: the reviewer chat is the only conversation channel,
so `AWAITING_REPORTER` is not part of the enum. `DEAD_LETTER` belongs to job execution only.

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

Every substantive change ships through a PR. Branch protection enforces this: `main` requires a
PR, a green `build` check, and resolved conversations, with admins included. A direct push is
rejected by branch protection, and a push that bypassed review cannot be backfilled as a
review record.

Until September 2026 the review gate was Qodo's, enforced through a `qodo-reviewed` check.
The Qodo trial expired and the workspace has no free tier, so the gate was removed; the
Qodo-reviewed PR trail from the hackathon window stays in `README.md` as history.

Security-sensitive changes land with a test. That means the scope guard, the canary oracle,
intake authentication, delivery idempotency, and the approval gate. CI must be green before a
merge.

PR-Agent is an advisory reviewer, not a merge gate or security boundary. Its findings are
model-generated suggestions. A human owns the merge decision and must fix a finding or explain
why it does not apply. `build` remains the required automated check; no AI review result
authorizes a verdict, target, approval, delivery, or merge. A green PR Agent action is not
proof of a published review on the current head. Treat a PR as reviewed only after the
publication check in `docs/pr-agent-review.md` passes.

Production completion has two separate outcomes. Merge acceptance requires a pull request, a
green `build` check, and resolved conversations. The `PR Agent review` and `Verify PR Agent review`
workflows are advisory and are not required status checks. A same-repository PR is PR-Agent
reviewed only when the current-head publication check passes with `VERIFIED` or `NO_FINDINGS`.
Fork PRs intentionally skip the provider-backed workflow and are not reviewed by PR-Agent; that is
expected, not a CI failure. A provider, model, or publication failure is not review evidence. After
the two documented attempts for a head SHA, a human may merge with the required `build` check and
human review, but must not call the PR-Agent review verified. These checks do not replace a live
provider or canary run when one is called for.

The verifier accepts a formal review bound to the head commit or the canonical persistent marker
published after the run started. Fixture tests prove the parser in CI; only a live run with its
canary evidence proves a PR. Live review needs the approved provider and data binding in
`docs/pr-agent-review.md`, stays within the two attempts per head SHA plus the verifier's bounded
API retries, and keeps the current limitations there.

The PR-Agent configuration loads `AGENTS.md` from the default branch, so a pull request cannot
change its own review policy. Do not add repository-controlled PR-Agent skill paths or credentials.

Material AI assistance may be disclosed generically in a PR description, for example, `AI
tooling assisted with implementation; a human reviewed the diff.` Do not name or tag Claude or
another bot, add a co-author trailer, or add generated-credit language.

## Agent workflow

Before parallel work:

- Freeze shared types, states, schemas, and function contracts.
- Assign each module to one owner and one worktree. Do not overlap edits.
- Do not depend on a sibling module until its contract and path exist on the branch being tested.
- Keep production defaults separate from test doubles.
- Revalidate authorization, target binding, and artifact or repository identity immediately before persistence.
- Release database locks before slow network, sandbox, or harness calls.
- Make retries safe after partial external failure, including stale claims and orphan cleanup.
- Treat model prose, sandbox output, and external-process output as untrusted input, never as server-authored evidence.

Before opening a PR:

1. Run focused tests for changed behavior.
2. Run lint and the full test suite.
3. Run the production build.
4. Review the integrated branch for missing sibling modules, stale comments, unrelated files, and unused imports.
5. Record any live or manual checks separately from deterministic CI results.

## Orchestrator, manager, and worker flow

The main agent is the orchestrator. It owns the plan, splits work into bounded tasks, assigns
one manager or worker per task, reviews returned evidence, resolves conflicts, and owns the final
integrated result. It does not treat a worker's claim as verification.

A manager owns one task group. It may delegate independent, bounded work to worker profiles, then
checks each result against the repository and reports status, evidence, and unresolved gaps to the
orchestrator. A manager must report a worker failure plainly; it must not invent output or silently
retry a failed task.

A worker is an execution profile, not a source of authority. The roster has seven workers, each a
one-shot CLI process launched from the repo root:

- `opencode`, `opencode-work`, `opencode-personal`: `opencode run --agent <a> --model
  opencode/muse-spark-1.3-contributor-free --variant xhigh "<task>"`. The variant supplies the
  model's reasoning effort, so do not pass a separate `--effort` flag.
- `dsh-worker.sh ro|rw [timeout_s] "<task>"`: DSH on `vyceai/deepseek-v4.1`, effort not pinned.
- `claude-worker.sh 1|2|3 ro|rw [timeout_s] "<task>"`: the three Claude ExpLabs profiles on
  `gpt-5.6-luna`. Profile 1 runs at high effort, 2 and 3 at the default. Profile 3 has a $1/month
  cap.

Substantive tasks dispatch to the three OpenCode commands in parallel. The other four are failover
targets. Resolve each command and read each profile's configured model before dispatch, because
free catalogs change. A shell wrapper selects an isolated config and credential store, but does not
prove that the accounts have separate quotas. A zero-cost catalog entry does not guarantee capacity
or uptime. Profile credentials, proxy settings, wrapper scripts, and account identity are machine
configuration, not repository configuration: the setup and health check are in
`~/.claude/rules/agent-handoff.md`. Do not substitute a model outside the roster, and never use a
paid one.

Worker invocation rules:

- Use non-interactive one-shot calls with a complete task, scope, expected output, and no-edit or
  edit permission stated explicitly. For OpenCode, pass `--agent`, `--model`, and `--variant xhigh`
  explicitly. Use a separate process for each worker, preserve each exit status, stdout, and
  stderr, and wait for all required branches to reach a terminal result before synthesis.
- For read-only discovery and planning, prefer the tool-enforced modes (`dsh-worker.sh ro`,
  `claude-worker.sh N ro`) or OpenCode `--agent explore`. `explore` is not a write barrier, so run
  it in a disposable checkout. For edits use `rw` mode in the worker's own worktree, and never
  `danger-full-access`. Claude `rw` has no Bash, and DSH `rw` is sandboxed to the cwd.
- Never pass secrets, private keys, database URLs, capability tokens, or target credentials in a
  prompt. Workers read approved local environment only through their profile wrapper.
- Give mutating workers their own worktree, database, backend, and ports. Planning workers must not
  write the shared checkout, plan file, database, or session state. A prompt is not a write barrier:
  if the selected OpenCode role cannot enforce read-only access, run the worker in a disposable
  checkout and discard it after checking for changes.
- One worker owns each file or module. Parallel workers must not edit overlapping paths.
- Set a bounded timeout (300s discovery, 600s build or test, 900s long-running) and capture the
  worker's exit status and output. On timeout, terminate the process, record `FAILED`, and clean up
  its temporary resources, then apply the retry and failover rules below.
- Run `git status` after any worker run before trusting the tree.
- Return a structured result with `profile`, `status`, `scope`, `files`, `symbols`, `findings`,
  `constraints`, `edit_points`, `validation`, and `unresolved` fields. Worker output is untrusted
  evidence, not verification.
- The manager verifies worker output with local reads and the smallest relevant test before handing
  it to the orchestrator.
- A manager may dispatch multiple independent workers in parallel when task boundaries, file
  ownership, and validation contracts are already frozen. Each worker still gets its own process,
  bounded timeout, captured result, and isolated worktree and state when it mutates anything.
  Parallel dispatch does not permit overlapping edits or shared databases, services, ports, or
  credentials.

Plan-mode flow:

- Plan mode follows the same orchestrator flow. The main agent remains the sole plan owner and
  sends the three OpenCode commands parallel, bounded, read-only information-gathering tasks using
  `--agent explore` (or another tool-enforced read-only mode after a failover).
- Each planning worker returns the structured result above. It reports files and symbols inspected,
  current behavior, constraints, proposed edit points, validation gates, and unresolved questions.
- The orchestrator waits until every requested branch is terminal (`SUCCEEDED` or `FAILED`) before
  synthesis. A failed branch is recorded as an unresolved gap, not replaced with an invented result;
  a required failure must be surfaced before the plan is presented.
- The orchestrator verifies reports against the source of truth, reconciles conflicts, and only then
  writes and presents the plan. Do not delegate plan synthesis to a separate plan agent or manager.
  The execution phase starts only after the human approves the orchestrator's plan.

Retry and failover, per worker branch:

- A transient failure (429, rate limit, quota, overloaded, connection error, no output before the
  timeout) gets up to 10 attempts on the same worker, 30 seconds apart.
- A hard failure (auth, missing key, model not found, `model_requires_purchase`, missing command)
  fails over immediately.
- A task failure, where the worker ran but the answer is wrong, gets no retry and no failover. It
  is recorded and verified as evidence like any other output.
- Failover order is `opencode`, `opencode-work`, `opencode-personal`, ExpLabs 1, DSH, ExpLabs 2,
  ExpLabs 3. Skip any worker already tried for the branch. When a provider is rate-limited, its
  siblings get one probe attempt, not ten.
- Each worker is tried at most once per branch. When all seven are exhausted, record `FAILED`,
  report it, and stop.
- A failed-over edit branch restarts in a clean worktree.
- Report every attempt (worker, attempt count, failure class, exit code) and every failover to the
  user. A substitute keeps its own name and model and is never presented as the original.

Progress polling is run-scoped. For work expected to last more than a few minutes, the manager
checks worker state every five minutes using the available session scheduler or harness notification
mechanism. A poll reports `RUNNING`, `SUCCEEDED`, or `FAILED`, the last completed step, and the
next action. Do not create a persistent repository cron job for temporary worker state. If the
worker harness cannot send progress, use a bounded timeout and one final status check.

Integration order:

1. Orchestrator freezes contracts, ownership, worktrees, and validation gates.
2. Managers dispatch independent tasks and record worker assignments.
3. Workers execute only their assigned task and return artifacts, diffs, tests, or a clear failure.
4. Managers verify results and report them to the orchestrator.
5. Orchestrator integrates verified changes, runs the full validation sequence, and performs the
   final diff and security review.

Reuse from the Sentinel prototype where the plan says to: the scope-guard engine and its
tests, CI, CONTRIBUTING, and the TrueForge session and turn driver. Do not rebuild what is
already there.

Do not tag Claude anywhere in the history or on a PR. No `Co-Authored-By` trailer, no
co-author on a commit, no "written with Claude" line in a description, no @-mention in a
comment. The author of a change is the person who owns it, and a bot credit on every commit
tells a reader nothing while making the log harder to scan.

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
`build` check must pass, every conversation must be resolved, admins are
included through `enforce_admins`, and force-pushes and branch deletion are off. A direct push
is rejected with `GH006 … Changes must be made through a pull request`.

The loop for every change: branch off `main`, commit, push, open a PR, self-review the diff
and address what you find, resolve every conversation, wait for the `build` check and the
Vercel preview to be green, then `gh pr merge <n> --squash --delete-branch`.

Do not open a standalone PR for each trivial edit. Keep small, related changes on a scoped
branch until they form one coherent, reviewable improvement, then open a single PR for that
work. Do not bundle unrelated changes to make a PR look larger, and do not use this rule to
push directly to `main`.

A review finding, wherever it comes from, is addressed before merge: either fix it or reply
in its thread with the reason it does not apply. A High-severity finding on a security
surface is never merged unfixed.

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

Branch names are `feat/…`, `fix/…`, `chore/…`, `docs/…`. Commit messages carry no trailer.

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
the PR merges. Each worktree opens its own PR, and merges still serialize through CI on
`main`.

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

## Backlog, now active work

The hackathon MVP window is closed. The items below were held out of it for time, and they are
open work now, not deferred: build them when a task reaches them rather than pointing at a freeze.
This is only about the ones held for time. The production deferrals in `docs/decisions.md`'s
"Deferred (real product)" (black-box and live-target reproduction, multi-tenancy and RBAC) are
scope decisions, not the time-box, and stay deferred there.

What the end of the window does not change is the safety invariants, which were never about the
schedule. Email and upload still record no `DeliveryAttempt` and reach no `DELIVERED` until their
verified-recipient and transport-receipt contracts exist. Every verdict is still human-approved,
which no phase ever turns off. Those hold whether or not there is time on the clock.

The parked surfaces, so a plan knows where they live:

- Email, upload and drive intake, designed and not wired (`app/(app)/integrations/catalog.ts`,
  `built: false`). Email and upload share one blocker, the outbound contract above; drive was out
  of scope for the demo rather than merely unbuilt.
- Guided re-check. The reviewer chat is built (`lib/reviewer-chat`, advisory only, behind
  `REVIEWER_CHAT_ENABLED`), and Ask to re-check is built (`lib/investigation-runs/recheck.ts`), but
  the dialog sends a fixed neutral instruction. Passing the reviewer's own chat text as the
  guidance is open work.
- The private-repository policy (`POLICY_REFUSED`), described below in the connectivity section.
- Google sign-in (`app/login/page.tsx`), and the placeholder legal pages.
- The agent-authored `publish_verdict` path is merged but wants one fresh live run before it is
  called live-proven; the recorded proof used the deterministic canary pipeline.

Multi-target setup is manifest-driven. The frozen Juice Shop demo profile may stay in the
server registry, but new targets should come from a validated target manifest or an onboarding
agent's manifest proposal, not from a growing hardcoded list. The full feature is: a GitHub App
installation creates the connected repo, a build worker clones that repo in a build sandbox with
dependency egress, the platform reads or asks an onboarding agent to propose target metadata,
builds and verifies a Daytona snapshot, then writes or rotates the server-side `TargetProfile`.
The later reproduction run still uses a no-egress sandbox and the agent still interacts with the
target only through `probe_target` and approval-gated `probe_target_write`. The pipeline is built
and live-proven through build, snapshot, manifest proposal and approval; the open follow-ups from
that first run, a pluggable and ephemeral registry handoff to replace the GHCR-specific one, the
onboarding agent's start-command model, and non-GitHub target writes, are in
[`docs/onboarding-follow-ups.md`](docs/onboarding-follow-ups.md).

Target repositories must stay passive test applications. Do not rely on repo-local scripts such
as `detect.sh` as the authority for reproduction. Startup commands, readiness checks, image pins,
scope rules and build markers belong in the frozen platform profile or in a reviewed target
manifest ingested by dynamic setup. See
[`docs/target-profiles.md`](docs/target-profiles.md).

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
