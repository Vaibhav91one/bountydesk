# BountyDesk — Phase-by-phase MVP plan

This plan implements the frozen scope in [decisions.md](./decisions.md). A phase is complete only
when its exit criteria pass. Deferred production features must not silently enter the hackathon MVP.

## Phase 0: Repository and review trail

**Status:** complete.

- Next.js/TypeScript scaffold, CI, contribution rules, branch protection and Qodo review trail.
- Environment template and committed architecture/design records.

**Exit:** clean install, lint and production build pass through a reviewed PR.

## Phase 1: Contracts, persistence and configuration

- Add Drizzle with Supabase Postgres migrations.
- Implement separate `InboundJob` and `Report` state machines using the enums in `AGENTS.md`.
- Add `TargetProfile`, `GitHubInstallation`, `ConnectedRepository`, session/event, artifact,
  approval, outbox and delivery-attempt persistence.
- Add typed server-environment validation. Never expose server secrets through `NEXT_PUBLIC_*`.
- Enforce unique `(channel, delivery_id)`, leases and `FOR UPDATE SKIP LOCKED` worker claims.

**Exit:** migrations run through `DIRECT_URL`; runtime uses `DATABASE_URL`; transition and lease
tests reject invalid states, duplicate work and missing security configuration.

## Phase 2: Identity, GitHub App connection and durable intake

- GitHub OAuth authenticates the operator only; it never requests broad repository scopes.
- Install the GitHub App Vercel-style and persist selected repositories by immutable GitHub IDs.
- Verify raw-body `X-Hub-Signature-256` before parsing and persist the delivery before returning 202.
- Process `issues`, `installation`, `installation_repositories` and `repository` lifecycle events.
- Disable intake/delivery immediately on suspension, uninstall or repository removal.
- Accept email and file-upload intake as channels in their own right. Neither depends on a
  GitHub connection: both can create and triage a report with no repository connected.
  Accepted and unbuilt; no route exists yet.

**Exit:** install, selected-repository change, signed issue delivery, replay, suspension and uninstall
tests pass. A forged webhook performs no write.

## Phase 3: Triage, scope boundary and analysis fallback

- Bind every reproduction attempt to a server-owned `TargetProfile`; tools never accept an
  agent-selected target. A report may remain targetless for analysis.
- Implement deterministic scope and evidence checks with explicit provenance and tool-error states.
- Surface semantic duplicate candidates for human review; only exact delivery replays auto-no-op.
- Produce the visibly distinct analysis-only packet without a verdict or severity.
- Parse untrusted email and uploaded content in a disposable intake environment with no
  external network and no platform secrets.
- Support reports that have no target profile, and let a reviewer bind an authorised profile
  afterwards. Resuming then needs a future `ANALYSIS_ONLY → REPRODUCING` transition and
  transition tests; the current state machine rejects it. Record why a report is analysis-only
  as a reason in the existing event payload beside the state:
  `NO_BOUND_TARGET`, `COULD_NOT_BUILD`, `COULD_NOT_DEPLOY`, `NO_APPROVED_ORACLE`,
  `TARGET_UNAVAILABLE`, `POLICY_REFUSED`, `INTAKE_PARSE_FAILED`. None of these is a report
  state, and these initial event reasons need no enum migration.

**Exit:** out-of-scope targets cannot reach clone/deploy/egress capabilities, and fallback output makes
no automated genuine/fake claim.

## Phase 4: Reproduction against pinned and dynamic targets

- Start with the provisioning spike. It gates everything else in this phase: prove that
  BountyDesk can provision the environment, that a `TargetProfile` selects the exact snapshot,
  that the built artifact corresponds to the connected commit, that the amd64 digest verifies,
  that the target starts with no runtime downloads, that build egress is restricted and
  reproduction egress blocked, that cloud metadata is unreachable, that resource limits hold,
  and that TTL plus reconciliation destroy abandoned sandboxes. A failure at any gate produces
  `ANALYSIS_ONLY` with an infrastructure reason, never `NOT_REPRODUCED`.
- Build the connected fork at its pinned commit ahead of the live run and record the source
  archive, build recipe, base image and generated image digests, then provision the immutable
  snapshot and verify its configured digest.
- Run the pinned demo snapshot offline with strict per-report budgets.
- Seed an unpredictable canary through the trusted fixture, run the negative control first, execute
  the PoC, and evaluate the oracle outside the PoC environment.
- Implement both frozen scenarios from Q18 and always tear down through provider TTL plus reconciler.
- Add the dynamic tier only after the pinned connected-fork path works end to end. The trusted
  controller resolves the commit, then downloads, hashes and stages a public source archive.
  The build sandbox consumes that archive without a repository token. Build,
  then reproduce against the immutable output in a second sandbox with no network. Require
  build authorisation before source execution, then require a separate reproduction approval
  bound to the generated image digest, snapshot ID and build attestation. Enforce the Q20 rule
  that a profile with no fixture and oracle cannot emit `REPRODUCED`.

**Exit:** both scenarios reproduce from fresh sandboxes; negative controls remain false; digest,
egress and teardown failure tests fail closed; a build that does not complete yields
`COULD_NOT_BUILD` rather than `not-reproduced`; and a target without an approved fixture cannot
emit `REPRODUCED` even when the PoC claims success.

## Phase 5: Human approval and idempotent delivery

**Status:** complete for the worker components. The persistent deployment runner is not built.

- Draft and freeze the outbound payload before the native TrueForge `@write` approval gate.
- Bind approval to the exact content hash, `threadId` and `toolCallId`; serialize turns per report.
- In one DB transaction persist the final verdict and outbox intent.
- A delivery worker mints a short-lived installation token, posts once with a stable idempotency
  marker, records each attempt, and discards the token.

**Exit:** changed payloads, stale approvals and concurrent turns are rejected; retries never duplicate
the GitHub comment; denied reports produce no downstream effect.

Confirmed 2026-08-28 with `createTrueforgeAnalysisDriver` wired into the jobs tick and local
worker in place of the stub driver, a permanent end-to-end test covering intake through
delivery, and a live run against the local TrueForge harness: a real session and turn, the
model calling `publish_verdict` directly (the agent manifest sets `preload: true` on the
`bountydesk` MCP server so the tool is exposed upfront rather than through TrueForge's
`call_tool` dispatcher, which the poller correctly refuses since it's neither an `mcp`-type
call nor named `publish_verdict`), the poller resolving the pending call, a reviewer's Allow,
the submission worker relaying it to TrueForge, and the harness's real invocation of
`publish_verdict` moving the report to `DELIVERING`. The run stopped there rather than posting
a live GitHub comment, the same boundary the Phase-5-foundation smoke test already drew.
The four internal tick routes still need an operator locally. The planned Zerops deployment does
not add an external scheduler: one long-running Node process imports the four queue processors and
drives them directly. That runner is not built, so this status does not claim that a deployed report
advances unattended. See [`deployment.md`](deployment.md).

## Phase 6: Product UI, resilience and demo release

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
- Live-target and black-box reproduction for scope that cannot be self-hosted.
- Outbound delivery adapters for email and upload, including verified recipient identity and a
  transport receipt. Until those contracts exist, the app must not record a `DeliveryAttempt`
  or move one of these reports to `DELIVERED`.
- Production multi-tenancy/RBAC, encrypted tenant secret storage and microVM isolation rollout.
- Automatic semantic-duplicate closure, automated severity, or any verdict without human approval.
