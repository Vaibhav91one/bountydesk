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

Intake and reproduction are separate. A report enters through one of four independent
channels (`intake_channel`): `github` (issues), `advisory` (GitHub security advisories filed
through private vulnerability reporting), `email`, and `upload` (the public `/submit` page). Drive
intake is dropped. Email and upload need no GitHub connection to create and triage a report.
Reproduction is what needs a server-authorised `TargetProfile`, and a report without one stops at
`ANALYSIS_ONLY` with nothing cloned, built, deployed or probed. A target can come from a connected
GitHub repository, public or private, or from a non-GitHub source (an archive, a single Dockerfile,
or a prebuilt image pinned by digest) bound through `configureConnectionlessTarget`
(`docs/decisions.md` Q30).

Connectivity is the GitHub App model, not manual webhooks. OAuth login is identity, the App
install is repo access. Least privilege is Metadata read, Issues read and write, and Repository
security advisories read and write, with the `issues`, `repository_advisory` and lifecycle events.
Advisories are a private intake and the surface the verdict goes back to: a `repository_advisory`
`reported` or `published` delivery becomes an `advisory` report held at `NEEDS_DECISION`, and
because GitHub has no comments API for advisories, the approved verdict is delivered by editing the
advisory's description (`docs/advisory-intake.md`). An email report bound to a connected repository
with a live grant, whose installation has accepted Repository security advisories write
(`github_installation.repository_advisories_permission`), delivers the same way, by opening a draft
advisory, instead of an email reply.
Cloning a connected repository does not widen the permissions: a public repository clones
anonymously, and Contents read is needed only for a private one. The private-repository policy
accepts and triages the report, then refuses reproduction with `POLICY_REFUSED` (and onboarding refuses to clone) until
that permission is deliberately added and accepted. Visibility is stored on
`connected_repository.is_private` and the granted permission on
`github_installation.contents_permission`, both from the lifecycle webhooks with the reconcile tick
as backfill. A private clone uses an installation token scoped to that one repository and narrowed
to contents:read, passed through a credential helper rather than the URL and revoked right after
the clone (`lib/github/repo-access.ts`). The webhook secret belongs to the
platform, and `installation_id → repo → TargetProfile` resolves server-side. Mint short-lived
installation tokens per delivery and discard them. Keep access in sync from the `installation`,
`installation_repositories`, and `repository` lifecycle webhooks: a suspended or deleted
installation, or a removed repository, must stop intake and delivery at once.

Job execution and report lifecycle are separate enums. Job execution runs
`RECEIVED → PARSED → SESSION_CREATED → RUNNING → DONE | DEAD_LETTER`. Leasing (`lease_owner`,
`lease_expires_at`, `attempts`, `fence`) is orthogonal to that, not a state of its own. An
outside email or advisory report held at the intake gate finishes its job at `PARSED → DONE`; an
upload report is created by its route directly, with no job. The frozen
report enum is `TRIAGING | NEEDS_DECISION | REPRODUCING | ANALYSIS_ONLY | AWAITING_APPROVAL |
DELIVERING | DELIVERED | DENIED | OUT_OF_SCOPE | CANCELLED | EXPIRED`, and the last five are
terminal. `NEEDS_DECISION` is the gate an outside (non-allowlisted) email report, every advisory
report and every upload report waits at before anything runs on it; only a reviewer moves it on, to
`TRIAGING` or `DENIED` (`docs/decisions.md` Q25, Q27, Q32). `OUT_OF_SCOPE` is narrow: an operator
quarantine that rules a bound target out of scope, or a static review of a target that could not be
built or deployed which read no source and drafted nothing (Q31). A target that cannot be built or
deployed otherwise ends `ANALYSIS_ONLY` with a static review, and a missing target never produces
`OUT_OF_SCOPE`. There is no reporter-reply state: the reviewer chat is the only conversation channel,
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

The `Claude review` workflow is the advisory reviewer, not a merge gate or security boundary. Its
findings are model-generated. A human owns the merge decision and must fix a finding or explain in
its thread why it does not apply. `build` remains the required automated check; no AI review result
authorizes a verdict, target, approval, delivery, or merge.

Merge acceptance requires a pull request, a green `build` check, and resolved conversations.

It reviews a same-repository pull request when it opens, reopens or is marked ready, on every push,
and again when the owner, a member or a collaborator comments `/review`. A new push cancels a review
still running on the old head. It is not a required status check. A PR counts as reviewed when its
summary comment carries `<!-- claude-review head=<sha> -->` for the current head; the workflow's
read-only `head-check` job compares the latest marker with the head after each review and fails,
advisory only, when it is missing or stale. Fork PRs are not reviewed, which is expected, not a CI
failure. If the review fails or is missing, a human may merge with the required `build` check and
human review, but must not describe the PR as reviewed by it.

A pull request cannot change its own review policy. The workflow runs from the default branch on
`pull_request_target` and `issue_comment`, the default branch is checked out as the working tree,
and the pull request's files are read only as data from `pr-head/`. Claude has read tools and
`gh pr` only, so no pull request code runs. Its setup and guards are in
[`docs/claude-review.md`](docs/claude-review.md), and `.github/scripts/claude-review-policy.test.mjs`
fails CI if one of them is loosened. Do not add repository-controlled review skills or credentials.

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

The committed source of truth is [`docs/decisions.md`](docs/decisions.md) covering Q1 to Q32,
[`docs/demo-runbook.md`](docs/demo-runbook.md), and [`docs/plan.md`](docs/plan.md). The advisory
channel is in [`docs/advisory-intake.md`](docs/advisory-intake.md), and upload and non-GitHub
targets in [`docs/upload-and-nongithub-targets.md`](docs/upload-and-nongithub-targets.md). When
this summary is ambiguous, defer to those records and ask rather than guess.

## Operator prerequisites

Some of what is built needs a person to switch it on. None of it can be stubbed.

- GitHub App permissions: Metadata read, Issues read and write, Repository security advisories read
  and write. Add Contents read only for installations that want private repositories reproduced.
  Each installation owner has to accept a changed permission set before it takes effect; until
  then email reports get the email reply rather than an advisory, advisory writes are refused and
  held (a reviewer retries them from the case file once the permission is accepted), and private
  repositories stop at `POLICY_REFUSED`.
- GitHub App events: `issues`, `repository_advisory`, `installation`, `installation_repositories`
  and `repository`.
- Private vulnerability reporting turned on in each repository that should take advisory reports.
  That is a repository setting, and the repository must also be connected with a bound target.
- Optional env, on the worker unless noted: `REGISTRY_HOST`, `REGISTRY_USER`,
  `REGISTRY_NAMESPACE` and `REGISTRY_PUSH_TOKEN` point the build at a registry other than GHCR (the `GHCR_*` values are the
  fallbacks); `REGISTRY_DELETE_TOKEN` (a `delete:packages` token) lets the build delete its pushed
  image once the snapshot is active; `PREBUILT_IMAGE_REGISTRIES` lists the registries a prebuilt
  image may come from (default `docker.io,ghcr.io`), and must be set on both Vercel and the worker
  because both check it. See `env.example`.
- Migrations are run by hand. Merging a migration passes `build` but does not touch the production
  database: run `npm run db:migrate` with `DIRECT_URL` from a trusted machine after it merges.
- Worker code (delivery, jobs, build onboarding, the upload build loop) runs on the Zerops worker, so
  a merge to `main` does not deploy it; the worker needs its own push.

## Backlog

The hackathon MVP window is closed, and the items it held back for time are built: email both
ways, outside email intake, upload intake, advisory intake and delivery, private repositories,
non-GitHub targets, the static fallback, Google sign-in, and the legal pages.

What never changes is the safety invariants. No channel records a `DeliveryAttempt` or reaches
`DELIVERED` without a verified recipient and a transport receipt. Email's recipient is an
allowlisted address, or an outside sender's address that passed inbound SPF and DKIM aligned with
its From domain and is recorded as the report's `verified_sender`, re-checked at send time; the
receipt is Resend's `email.delivered` webhook. Provider acceptance is not that receipt, so an
accepted send earns `SENT` with a null `delivered_at` and the report waits in `DELIVERING`. Upload
rides the same email transport: its recipient is the contact the uploader proved with a
report-scoped one-time code (recorded as `verified_sender`), and an unconfirmed contact is refused.
An advisory's recipient is the repository grant, re-checked at send, and its receipt is GitHub's
2xx on the edit or create. Every verdict is still human-approved.

Still open or deferred, so a plan knows where they stand:

- The agent-authored `publish_verdict` path is merged but wants one fresh live run before it is
  called live-proven; the recorded proof used the deterministic canary pipeline.
- The open onboarding items in [`docs/onboarding-follow-ups.md`](docs/onboarding-follow-ups.md):
  rotating a connectionless profile, a tarball without a Dockerfile, reclaiming mesh images, and
  scheduling the trial-snapshot sweep.
- Deferred by scope, not time (`docs/decisions.md` "Deferred (real product)"): multi-target
  expansion, the agentic code review module (kept separate from onboarding), black-box and
  live-target reproduction, RBAC and multi-tenancy, and the pentest agent
  (`docs/pentest-workbench.md`).

Multi-target setup is manifest-driven. The frozen Juice Shop demo profile may stay in the
server registry, but new targets should come from a validated target manifest or an onboarding
agent's manifest proposal, not from a growing hardcoded list. The full feature is: a GitHub App
installation creates the connected repo, a build worker clones that repo in a build sandbox with
dependency egress, the platform reads or asks an onboarding agent to propose target metadata,
builds and verifies a Daytona snapshot, then writes or rotates the server-side `TargetProfile`.
The later reproduction run still uses a no-egress sandbox and the agent still interacts with the
target only through `probe_target` and `probe_target_write`. `probe_target_write` is auto-approved
inside the sandbox rather than paused for a human: the only network a write probe can reach is that
reproduction sandbox, offline under `networkBlockAll` with no egress and torn down after the run, so
there is nothing outside it for a human to protect. The human gate that guards the outside world is
`publish_verdict`. See `docs/decisions.md` (Q16 for the offline sandbox, Q11 for the gate) and
`autoApproveWriteProbe` in `lib/agent-sessions/poller.ts`. The pipeline is built
and live-proven through build, snapshot, manifest proposal and approval. The follow-ups from that
first run (the pluggable registry handoff, image reclaim, start-command verify and non-GitHub target
writes) are built, and what is still open is in
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
