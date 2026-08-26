# BountyDesk — agent guide

Automated bug-bounty triage. A report is authenticated, scope-checked, reproduced against a pinned
target in an isolated sandbox with a defender-authored **canary oracle**, and shipped as a verdict
**only after a human approves the exact outbound comment**. Built on the TrueForge agent harness.

This file is the single source of project instructions. `CLAUDE.md` only does `@AGENTS.md`, so keep
everything here.

## Architecture invariants (do not violate)

- **The verdict comes from the canary, not the model.** A fresh, per-run, unpredictable canary is
  seeded through a trusted fixture; the oracle is evaluated **outside the sandbox**. Run a negative
  control first. The model never narrates the verdict.
- **The human gate is never skippable.** `publish_verdict` is approval-gated; the tool refuses any
  payload whose content-hash ≠ the approved one. No auto-close, ever — semantic duplicates go to a
  human as top-k, only exact delivery replays are auto no-ops.
- **GitHub App model** (not manual webhooks): OAuth login = identity, App install = repo access.
  Least-privilege = Metadata read + Issues read/write. Webhook secret is platform-owned; resolve
  `installation_id → repo → TargetProfile` server-side. Mint short-lived installation tokens per
  delivery, then discard. Keep access synchronized from `installation`, `installation_repositories`,
  and `repository` lifecycle webhooks; a suspended/deleted installation or removed repository must
  disable intake and delivery immediately.
- **Dual state model.** Job execution and report lifecycle are separate enums.
  Job execution: `RECEIVED → PARSED → SESSION_CREATED → RUNNING → DONE | DEAD_LETTER`. Leasing
  (`lease_owner`, `lease_expires_at`, `attempts`) is orthogonal to this, not a state of its own.
  The frozen MVP report enum is `TRIAGING | REPRODUCING | ANALYSIS_ONLY | AWAITING_APPROVAL |
  DELIVERING | DELIVERED | DENIED | OUT_OF_SCOPE | CANCELLED | EXPIRED`; the last five are
  terminal. `AWAITING_REPORTER` is a post-MVP, non-terminal extension and must not be emitted until
  reporter-reply correlation ships. `DEAD_LETTER` belongs to job execution only.
- **Durable jobs table is the queue.** Idempotency = unique `(channel, delivery_id)`; decide by
  **state**, not existence. Insert `RECEIVED`, return 202 fast, worker drives states, sweeper
  reclaims expired leases.
- **Scope is bound at the capability boundary**, not from an agent string — clone/deploy/egress take
  the target from the server-held `TargetProfile`.
- Secrets stay server-side. The browser talks only to Next.js; SSE is proxied server-side (Node
  runtime, not edge). TrueForge stays on loopback/private, never public.

## Stack

- **Next.js (App Router) + TypeScript**, npm. This is a modified Next.js — see the block below.
- **Postgres (Supabase free tier) + Drizzle ORM.** Not SQLite: the app fronts on Vercel (no disk),
  and the jobs-table lease uses `SELECT … FOR UPDATE SKIP LOCKED` (a real row lock). `drizzle-kit`
  for migrations.
- **TrueForge** harness (`http://localhost:8790`, loopback), OpenAI first-class model provider.
- **scope-guard MCP** (ported from the Sentinel prototype), **Daytona** sandbox (pinned Juice Shop
  v17.3.0 amd64).

## Env

Copy `env.example` → `.env.local` (gitignored) and fill it. To start Phase 1 you only need the
DATABASE block: `DATABASE_URL` (pooler, port 6543, app runtime) and `DIRECT_URL` (direct, port 5432,
migrations). Never commit real secrets; `env.example` holds placeholders only.

## Working rules

- **Every substantive change ships via a Qodo-reviewed PR.** No direct pushes to `main` (branch
  protection enforces it: PR required + `build` status check + admins included). Direct pushes don't
  count toward the hackathon eligibility trail.
- Security-sensitive changes (scope guard, canary oracle, intake auth, delivery idempotency, approval
  gate) land with a test. CI must be green before merge.
- Reuse from the Sentinel prototype where noted in the plan (scope-guard engine + tests, CI,
  CONTRIBUTING, the TrueForge session/turn driver). Don't rebuild what's reusable.
- Disclose AI assistance in the PR.

## Git workflow

How this repo is run, and what is already set up:

- **`main` is protected** and this is enforced, not a convention: a PR is required, the `build` status
  check must pass, admins are included (`enforce_admins`), and force-pushes and branch deletion are
  off. A direct push to `main` is rejected (`GH006 … Changes must be made through a pull request`).
- **The loop for every change:** branch off `main` → commit → push → open a PR → the Qodo "Qodo Code
  Review" App auto-reviews it → address each finding in the PR thread (fix, or a reasoned dismissal)
  → CI green → `gh pr merge <n> --squash --delete-branch`. PR #1 established the eligibility trail; it
  cannot be backfilled, so nothing of substance skips this loop.
- **Branch names:** `feat/…`, `fix/…`, `chore/…`, `docs/…`. **Commit trailer:**
  `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **Stage only what your change owns.** The shadcn UI scaffold is intentionally left uncommitted in
  the working tree (`app/globals.css`, `app/layout.tsx`, `package.json`, `package-lock.json`,
  `components.json`, `lib/`, `.claude/`). Never sweep it into an unrelated PR; it lands with the UI
  phase. `git add` the specific files, never `git add -A` on this tree.
- Secrets never get committed. `.env.local` is gitignored; `env.example` holds placeholders only.

## Subagents run isolated — worktree + separate backend

Any subagent that **edits files or touches the database must run in its own git worktree with its own
backend**, never the primary checkout. This is the rule for parallel work: no shared branch, no shared
DB, no overlap.

- **Own worktree.** Prefer the Agent tool's `isolation: "worktree"` (it runs the agent on an isolated
  copy and auto-removes it if unchanged). Manually it is
  `git worktree add ../bd-<task> -b <task-branch>`; clean up with `git worktree remove` when the PR is
  merged. Each worktree opens its **own** PR — merges still serialize through Qodo + CI on `main`.
- **Own database.** Each agent gets a distinct `DATABASE_URL` so migrations and jobs-table rows from
  one agent never collide with another. Cheapest isolation: a throwaway local Postgres per agent
  (`docker run -e POSTGRES_PASSWORD=… -p <unique-port>:5432 postgres`) or a dedicated schema in a
  shared DB. Put the override in that worktree's own `.env.local`; run `drizzle-kit` migrations there
  against the isolated DB, never against the shared Supabase project.
- **Own ports.** Give each agent unique local ports for the app, TrueForge, and scope-guard
  (`APP_BASE_URL`, `TRUEFORGE_URL`, `SCOPE_GUARD_URL`) so two agents' services don't bind the same
  socket.
- Read-only subagents (search, review, analysis) don't need a worktree — isolation is only for agents
  that mutate files or state.

## Design record

The committed source of truth is [`docs/decisions.md`](docs/decisions.md) (Q1–Q19),
[`docs/demo-runbook.md`](docs/demo-runbook.md), and [`docs/plan.md`](docs/plan.md). When this summary
is ambiguous, defer to those records and ask rather than guess.

## Figma design files

Two Figma files hold the visual design and the technical flow diagrams. If you have Figma access,
open them by file key; both are named below so you can confirm you're in the right one. Design files
use the `/design/` path, FigJam boards use `/board/`.

- **BountyDesk — UI** (design file) — file key `eEs4G9lPqF9M0IGGBzy1Cd`.
  <https://www.figma.com/design/eEs4G9lPqF9M0IGGBzy1Cd/BountyDesk-UI>
  Pages, with node ids (verified 2026-08-26 via the Plugin API):
  - **Sitemap** `43:2` — route/screen map for public, app, settings and admin surfaces.
  - **Logo** `43:3` — "Trix the Triage Guardian" mascot and its animation states.
  - **Wireframes** `43:4` — grayscale low-fi layouts: Login, Review Queue, Reports, Case File
    ("Sign the verdict"), Channels (GitHub App install card), Scope.
  - **Screens** `43:5` — higher-fidelity screens.
  - **Design System · Dark Colors** `153:2` — the dark palette.

  Note for agents: `get_metadata` may list only the page that is currently open, because Figma loads
  pages lazily. That is not evidence a page is missing. To enumerate pages reliably, use `use_figma`
  with `figma.root.children`, and `await figma.setCurrentPageAsync(page)` before reading a page's
  contents.

- **BountyDesk board** (FigJam) — file key `K6z2IqS3ep6EtlriSWp8CE`.
  <https://www.figma.com/board/K6z2IqS3ep6EtlriSWp8CE/BountyDesk>
  Pages:
  - **Flow diagrams** — end-to-end technical flow (intake → triage → sandbox + canary oracle →
    approval → delivery), on the GitHub App model.
  - **Threat model** — attack chains and the honest sandbox-isolation story.
  - **UML** — data/domain model.
  - **Development Plan** — the phase-by-phase build plan as parallel swimlanes (Day-0 Gate → Tracks
    A/B/C/D → Converge). MCP-verified deep link (2026-08-26):
    <https://www.figma.com/board/K6z2IqS3ep6EtlriSWp8CE/BountyDesk?node-id=129-418>

The Figma files are design/reference, not a build dependency — treat `docs/` as the authority for any
decision; the boards visualize it. In particular, the Development Plan canvas still contains an older
job/report state model; implement the frozen enums in `docs/decisions.md` and `docs/plan.md`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
