# BountyDesk — Phase-by-phase MVP plan

This plan implements the frozen scope in [decisions.md](./decisions.md). A phase is complete only
when its exit criteria pass. Deferred production features must not silently enter the hackathon MVP.

## Phase 0 — Repository and review trail

**Status:** complete.

- Next.js/TypeScript scaffold, CI, contribution rules, branch protection and Qodo review trail.
- Environment template and committed architecture/design records.

**Exit:** clean install, lint and production build pass through a reviewed PR.

## Phase 1 — Contracts, persistence and configuration

- Add Drizzle with Supabase Postgres migrations.
- Implement separate `InboundJob` and `Report` state machines using the enums in `AGENTS.md`.
- Add `TargetProfile`, `GitHubInstallation`, `ConnectedRepository`, session/event, artifact,
  approval, outbox and delivery-attempt persistence.
- Add typed server-environment validation. Never expose server secrets through `NEXT_PUBLIC_*`.
- Enforce unique `(channel, delivery_id)`, leases and `FOR UPDATE SKIP LOCKED` worker claims.

**Exit:** migrations run through `DIRECT_URL`; runtime uses `DATABASE_URL`; transition and lease
tests reject invalid states, duplicate work and missing security configuration.

## Phase 2 — Identity, GitHub App connection and durable intake

- GitHub OAuth authenticates the operator only; it never requests broad repository scopes.
- Install the GitHub App Vercel-style and persist selected repositories by immutable GitHub IDs.
- Verify raw-body `X-Hub-Signature-256` before parsing and persist the delivery before returning 202.
- Process `issues`, `installation`, `installation_repositories` and `repository` lifecycle events.
- Disable intake/delivery immediately on suspension, uninstall or repository removal.

**Exit:** install, selected-repository change, signed issue delivery, replay, suspension and uninstall
tests pass. A forged webhook performs no write.

## Phase 3 — Triage, scope boundary and analysis fallback

- Bind every report to a server-owned `TargetProfile`; tools never accept an agent-selected target.
- Implement deterministic scope and evidence checks with explicit provenance and tool-error states.
- Surface semantic duplicate candidates for human review; only exact delivery replays auto-no-op.
- Produce the visibly distinct analysis-only packet without a verdict or severity.

**Exit:** out-of-scope targets cannot reach clone/deploy/egress capabilities, and fallback output makes
no automated genuine/fake claim.

## Phase 4 — Pinned reproduction and canary oracle

- Provision the immutable Juice Shop v17.3.0 linux/amd64 snapshot and verify its configured digest.
- Run the sandbox offline with one legal target and strict per-report budgets.
- Seed an unpredictable canary through the trusted fixture, run the negative control first, execute
  the PoC, and evaluate the oracle outside the PoC environment.
- Implement both frozen scenarios from Q18 and always tear down through provider TTL plus reconciler.

**Exit:** both scenarios reproduce from fresh sandboxes; negative controls remain false; digest,
egress and teardown failure tests fail closed.

## Phase 5 — Human approval and idempotent delivery

- Draft and freeze the outbound payload before the native TrueForge `@write` approval gate.
- Bind approval to the exact content hash, `threadId` and `toolCallId`; serialize turns per report.
- In one DB transaction persist the final verdict and outbox intent.
- A delivery worker mints a short-lived installation token, posts once with a stable idempotency
  marker, records each attempt, and discards the token.

**Exit:** changed payloads, stale approvals and concurrent turns are rejected; retries never duplicate
the GitHub comment; denied reports produce no downstream effect.

## Phase 6 — Product UI, resilience and demo release

- Complete dashboard, report detail, evidence review, GitHub connection states, empty/error/loading
  states, keyboard access, responsive layouts and bounded scrolling.
- Proxy SSE through the Node runtime and verify cursor-based reconnect after a process restart.
- Add rate/turn/token limits, a worker kill switch, attachment caps and safe evidence rendering.
- Rehearse the live happy path, analysis fallback, second scenario and prerecorded backup using
  [demo-runbook.md](./demo-runbook.md).

**Exit:** lint/build/tests and accessibility/overflow checks pass; the demo works after reconnect and
has all three backup paths prepared.

## Explicitly deferred

- Reporter reply/resume (`AWAITING_REPORTER`).
- Arbitrary-repository Dockerfile generation and live-target/black-box reproduction.
- Production multi-tenancy/RBAC, encrypted tenant secret storage and microVM isolation rollout.
- Automatic semantic-duplicate closure, automated severity, or any verdict without human approval.
