# BountyDesk — Decisions & Session Record

Working record of the review + grilling session for the BountyDesk / TrueForge hackathon project.
Last updated 2026-08-26. Repository companions:

- [`demo-runbook.md`](./demo-runbook.md) — the demo happy path, backups and pre-warm checklist
- [`plan.md`](./plan.md) — the implementation phases and exit criteria
- Figma board `K6z2IqS3ep6EtlriSWp8CE` — edited live this session (see Board changes)

The review HTML files remain historical working material outside the repository. This document,
the runbook and the plan are the committed source of truth.

The single reframe under everything: the model is the thing being attacked, so it cannot also be the thing enforcing the defense. Every "rule lives in the manifest" line is a prior that lowers casual attack rate, not a control. Only deterministic code outside the model counts as a control.

---

## Scope decision (hackathon, not production)

This is a one-week hackathon MVP, not a production adversarial system. Judging is benign inputs. So the security architecture (VM isolation, egress deny, oracle, scope-at-boundary) is documented on the board as the production target, and the demo runs a smaller, honest version. Findings were triaged into build-now / board-it / defer rather than all built.

Submission deadline: **Aug 30, 8:00 PM London**. Tracks: Best Use of TrueForge, Best Code Quality, Best UI.

---

## Verified external facts

Checked at source this session, not taken on trust (two research agents disagreed on OpenSandbox; the source settled it).

- **Qodo review is mandatory for eligibility.** Live rules: every substantive change goes through a GitHub PR reviewed by Qodo before merge; direct pushes to main do not count; README needs the exact heading `## Qodo Code Review Evidence`. Source: https://www.wemakedevs.org/hackathons/trueforge/rules
- **TrueForge approval model.** `require_approval_for_tools` is the *policy* — it decides which calls need approval, from the MCP annotation (`@write`/`@destructive` by default), named tools, or `@all`. Human response is **Allow / Deny only — no native Modify**. The *decision* is bound to `threadId` + `toolCallId`, supplied as a `user.tool_approval` item: `{ type: 'user.tool_approval', threadId, toolCallId, approval: { status: 'allow' } }` or `{ status: 'deny', reason }`. Sources: https://trueforge.dev/create-agent/overview.md , https://trueforge.dev/api/use-agent
- **TrueForge session/turn.** `sessions.create()` does not run the agent; `sessions.createTurnStream(session.id, …)` runs one turn. Approval does **not** resume the paused turn: "you resume by creating a **new turn**" carrying the approval items. Reconnect persists `session.id`, `turnId`, `lastSequenceNumber`; resume via `getTurn` then `subscribeToTurn` with `afterSequenceNumber` — the sequence number is **per stream/turn, not per session**. Critical: "Creating a new turn in a session automatically cancels any turn still running in that session," so turn serialization is mandatory, not hygiene. Source: https://trueforge.dev/api/use-agent
- **Postmark inbound has no HMAC signature.** Recommended auth is HTTP Basic + IP allowlist; sender `From` is still untrusted. GitHub uses `X-Hub-Signature-256` HMAC over raw body. Sources: https://postmarkapp.com/developer/webhooks/inbound-webhook , https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- **Daytona default is a shared-kernel container**, runs as root, 1 GiB minimum (not 512 MiB), egress tier-dependent, cleanup needs explicit TTL/reconciliation. Three runc host-escape CVEs landed Nov 2025 (CVE-2025-31133 / -52565 / -52881). Sources: https://www.daytona.io/docs/en/isolation/ , https://arxiv.org/abs/2606.08433
- **OpenSandbox is an orchestration SDK, not an isolation boundary.** README: "Supports secure container runtimes like gVisor, Kata, Firecracker" = pluggable option, not default; no threat model. Rejected as a boundary. Source: https://github.com/opensandbox-group/OpenSandbox
- **Verdict-from-attacker-text is the core risk.** Adversarial bug reports flipped LLM triage to attacker-aligned output 90% of the time; best filter caught 47%. Prompt-injection defenses (delimiting, "data not instructions") bypassed >90% under adaptive attack. Sources: https://arxiv.org/abs/2509.05372 , https://arxiv.org/abs/2510.09023
- **Elastic capacity numbers, read correctly.** ~70% of reports are rejected at analysis and never reproduced; of the rest ~40% warrant reproduction (~12% of all intake), confirming about half. The board's "2.5N" implied 40% of all reports and was ~3.3x off. Source: https://www.elastic.co/security-labs/ai-vulnerability-triage-bug-bounty-hackerone

---

## Resolved design (the grill, Q1–Q19)

### Q1 — Product shape
Repro-centric MVP with an analysis fallback when reproduction can't run. Reproduction is the differentiator; the fallback is graceful degradation, not a second-class path.

### Q2 — Target domain
Self-hostable-with-Dockerfile is priority (tier 1). Tier 2: any Git repo, generate a Dockerfile. Tier 3: not deployable, static scan → fallback. The assumption "target is a self-hostable app with source + boot command" is stated, not implied. Tier 2 build failure is its own outcome (`could-not-build`), never `not-reproduced`. **Amended 2026-08-27:** tier 2 is accepted and unbuilt rather than deferred, and lands as the dynamic tier in Q20. `could-not-build` is a reason recorded beside `ANALYSIS_ONLY`, not a report state: the report enum is frozen and adding to it would mean a migration nobody needs.

### Q3 — The verdict oracle (hardened)
`reproduced` comes from a **defender-authored canary oracle**, never the PoC's stdout or exit code. Anything transiting the report body or sandbox stdout is tainted and may not be the source of the verdict, severity, or any outbound-action argument.

A static marker is not enough — it is guessable and replayable, and if the PoC shares a filesystem with the target it can touch the canary without exploiting anything. Per run:

- Generate an **unpredictable** canary; never a fixed literal.
- Seed it through a **trusted fixture**, not through anything the PoC can reach directly.
- Evaluate the oracle **outside the PoC environment**.
- Isolate target and PoC filesystems and credentials; the PoC reaches the target **only** over the intended network interface.
- Run a **negative control before the exploit** — the same observation without the exploit step must not trip the oracle.

Caveat to keep on the record: "canary reached the trusted sink" is evidence, not proof that the *claimed* exploit path caused it, unless the controls above exclude the alternatives.

### Q4 / Q5 — Sandbox + hackathon framing
Demo runs on Daytona cloud (shared-kernel container, benign inputs only). Production runs a Kata microVM (Cloud Hypervisor / Firecracker backend) or E2B self-hosted, with host-side egress hardening. OpenSandbox rejected. This split is documented on the Threat Model board page.

### Q6 — Demo happy path
One pinned deliberately-vulnerable target (see Q18), SQLi confirmed by a per-run canary. **Amended 2026-08-27:** the planned target source is the owner's connected fork `Vaibhav91one/juice-shop` (repository id 1347703889) at commit `1867b926c5f50e4e692dc9c8f61821413cebe0cd`, which is the `v17.3.0` tag and the same commit as upstream's. That proves source equivalence, not runtime-artifact provenance. The existing scenario evidence came from the upstream image recorded in Q18. The connected-fork image must be built and both scenarios re-verified against its generated digest before the demo can call it frozen. Flow after that gate passes: GitHub issue → boot the **prebuilt pinned image** (no runtime clone, no install, no network at reproduction time) → seed a fresh unpredictable canary through the trusted fixture → negative control → run PoC → the out-of-sandbox oracle confirms the canary reached the trusted sink → evidence packet → human approves.

### Backup (demo resilience)
Three layers: (A) analysis fallback live — demo it as a feature when reproduction can't run; (B) pre-recorded run for total network/Daytona failure; (C) **a second scenario inside the same pinned target** — never a second target or a second architecture. Plus pre-warm: provision the sandbox and pre-pull the image before presenting.

### Q7 — Fallback claim strength
The fallback asserts **no verdict and no score**. No oracle here, so a genuine/fake call is a forgeable guess and a confidence number is farmable. It reports evidence; genuineness is the human's conclusion.

### Q8 — Fallback evidence schema
A fixed set of deterministic checks; only tool output counts as evidence. Three provenance tiers: Verified (deterministic tool result — the only tier that counts), Restated (from the report/PoC, marked untrusted), Observation (the model's read, weakest, humanizer never touches it). Checks v1: sink-exists (grep), version-in-range, route-real, reachability (Semgrep/CodeQL), prior-art. A check that can't run shows as `tool-error`, not a clean pass.

### Q9 — What the model produces in the fallback
`what` (interpretation of the claim, labeled not-fact), `where` (a location, counted as evidence only after a grep confirms it), and per-finding `consistency signals` (does each verified check match or contradict the claim). No global genuine/fake call.

### Q10 — Fallback routing and presentation
Always routes to a human; never auto-closes, never auto-rejects. "Insufficient signal" is a normal, non-terminal outcome. The fallback packet is visibly distinct from a reproduced one (header "Analysis only, not reproduced", own color, states no exploit was run). Humanizer edits only the researcher courtesy note.

**Duplicate handling is two different concepts and only one is auto-terminal:**

- **Delivery replay** — the same `(channel, delivery_id)` arriving twice. Deterministic, safe to no-op automatically. This is plumbing, not a judgement.
- **Semantic vulnerability similarity** — "this looks like an existing report." Subjective, ~68–74% recall at best. Surface the top-k candidates with scores; **a human decides**. Never auto-closes.

Out-of-scope (from the deterministic scope check) stays auto-terminal.

### Q11 — Approval mechanism
Use the **native** TrueForge gate: `publish_verdict` as a `@write` MCP tool caught by `require_approval_for_tools`. Native approval is Allow/Deny only, so **Modify = a pre-gate Generative UI form**; the edited, frozen payload becomes the tool arguments; Allow/Deny fires on exactly what will post. The tool refuses any payload whose content-hash doesn't match what was approved. Reject = Deny, Modify = the form, Allow = native approval. No custom checkpoint system.

### Q12 — What the gate covers (corrected)
Every consequential effect sits **behind** the gate, but they are not one atomic action — a DB transaction and a GitHub API call cannot be atomic. The correct shape:

1. Human approves.
2. **One DB transaction:** finalized verdict + outbox record + dedupe eligibility + researcher-facing status.
3. **Delivery worker** posts to GitHub idempotently (stable hidden marker or external delivery id so a retry cannot double-comment).
4. Record the `DeliveryAttempt` result.

The append-only event log is the only writer that runs without approval. A Denied verdict leaves a full audit trail and changes nothing downstream, so only human-approved outcomes ever feed dedupe.

### Q13 — Deployment topology
**One host.** The browser talks only to Next.js over HTTPS 443; Next.js proxies the SDK calls and the SSE stream server-side (Node runtime, not edge). TrueForge stays on loopback/private Docker net, never public (its local mode has no auth). API keys stay server-side. Vercel drops out of the request path (or serves only a static page). This removes the "Vercel can't reach private :8790" contradiction and the serverless SSE-timeout failure mode.

**Amended 2026-08-28.** Development remains local. The planned deployment separates public,
stateless work from persistent execution, with Supabase as the durable boundary between them.
Vercel receives intake, serves the reviewer UI and hosts the authenticated `publish_verdict` MCP
route. A private Zerops worker claims Supabase rows and calls a private TrueForge service. Vercel
never opens or holds a connection to TrueForge. The worker imports the four queue processors
directly; it does not run another Next.js server or call the public tick routes. TrueForge starts in
standalone mode with SQLite on Zerops Local Storage. Postgres and Valkey are required only if it
moves to multiple replicas. This supersedes the literal one-host rule while preserving its security
purpose: TrueForge and the worker are never public, and the browser still talks only to Next.js.
The deployment and its durability gates are recorded in [`deployment.md`](deployment.md).

### Q14 — Intake durability
**One durable jobs table.** Idempotency is a durable row keyed unique `(channel, delivery_id)`, and the decision is by job **state**, not existence: insert as `RECEIVED`, return 202 fast, then a worker drives `RECEIVED → PARSED → SESSION_CREATED → RUNNING → DONE` or `→ DEAD_LETTER`. A retry that collides checks state (terminal → 200 no-op; in-flight → ignore/resume) so nothing started is ever dropped. The table is the queue: worker leases (`lease_owner`, `lease_expires_at`, `attempts`) with a sweeper. **Persistence = Postgres (Supabase free tier) via Drizzle ORM** — the app fronts on Vercel (serverless, no persistent disk for a SQLite file), and Postgres makes the lease correct by construction with `SELECT … FOR UPDATE SKIP LOCKED` (a real row lock, not a faked global write-lock); Supabase/Neon are Postgres, so there is no dialect rewrite if we migrate hosts. Concurrency 1 for the demo, but the lock is real so it scales past 1 unchanged. Keep the idempotency key for the retention period, not 24h. Drop pool-cap/shedding/2.5N from demo scope or label unbuilt.

> **Webhook secret is platform-owned (Q13/Q14 note).** With the GitHub App model (see Q19) the App's webhook signing secret belongs to BountyDesk, not the customer — users never see or paste a secret. The `X-Hub-Signature-256` HMAC is verified against the platform-held App secret; users only install the App and pick repos.

### Q15 — Scope enforcement
Enforce at the **capability boundary**, not by the agent choosing to call `scope_check`. Bind every reproduction attempt to a server-matched **TargetProfile** (pinned commit/image, allowed host, ports); the clone/deploy/egress tools take the target from that profile, not an agent-supplied string, and refuse anything else. A report may exist without a profile and remain analysis-only. `scope_check` stays only as an agent-facing early-exit for the common case. For the demo: one server-authorised profile, derived from the connected fork. **Amended 2026-08-27:** the architecture carries additional authorised profiles (Q20); what does not change is that issue text, email bodies, attachments, PoCs and model output can never create one.

### Q16 — Install vs runtime egress
**Prebuilt pinned snapshot.** Bake the target + deps into an image in a separate trusted pipeline, so the hostile runtime sandbox needs zero network. The PoC runs against a fully offline target. "No egress" means no egress off the sandbox; loopback to the target is fine. Trusted build (target code) and hostile execution (attacker PoC, offline) form the trust split. That is what makes `npm ci --ignore-scripts` meaningful: it guards the build, while offline isolation contains the PoC. Verify emptiness: from the locked sandbox, curl an external host and `169.254.169.254`, both must fail. Attribute egress attempts to a process; don't assume a blocked attempt means a malicious submission. Tier-2 arbitrary-repo can't be safely pre-baked, because building it runs its code.

**Amended 2026-08-27.** That is now a reason to give the build its own sandbox rather than a reason to defer it. A dynamic run uses two sandboxes with one artifact crossing between them: a build sandbox with narrow dependency egress, and a reproduction sandbox with none. The pinned demo path is unchanged and still boots a prebuilt image offline.

Do not call the build sandbox trusted. It executes the customer's code, their Dockerfile instructions and their dependency lifecycle scripts, so it is an untrusted execution environment that happens to run earlier. The trusted parts are the controller, the authorisation policy, the approval records and the oracle. The residual risk is worth stating plainly: building customer code gives BountyDesk the attack surface of a CI system, and CI systems are a standing supply-chain target.

### Q17 — Session/turn lifecycle (corrected against the cookbook)
**One session per report** (Report 1:N turns). The initial turn runs triage, sandbox and drafts the verdict, then calls `publish_verdict`; the policy gates that call and the turn ends with a **pending tool call**. The human's decision does **not** resume that turn — you create a **new chained turn** carrying `user.tool_approval` bound to `threadId` + `toolCallId`. TrueForge's persisted session is still the checkpoint store, so nothing custom is built.

Retries (redraft after Deny, infra retry) are new turns too. Serialization is **mandatory, not hygiene**: "Creating a new turn in a session automatically cancels any turn still running in that session," so a stray retry turn silently kills a live run. The jobs table owns that serialization.

Reconnect is server-side: persist `session.id`, `turnId` and `lastSequenceNumber`; resume with `getTurn`, then `subscribeToTurn` with `afterSequenceNumber`. The sequence number is **per stream/turn, not per session**.

"Request more info" is deferred beyond the hackathon MVP. When reporter-reply correlation ships,
it adds the non-terminal `AWAITING_REPORTER` state and correlates a reply by `source_ref` back to the
existing report/session rather than creating a new report. The MVP must not emit this state.

**Frozen lifecycle clarification (2026-08-26).** The MVP report enum is `TRIAGING`, `REPRODUCING`,
`ANALYSIS_ONLY`, `AWAITING_APPROVAL`, `DELIVERING`, `DELIVERED`, `DENIED`, `OUT_OF_SCOPE`,
`CANCELLED`, and `EXPIRED`. The last five states are terminal. Job execution remains the separate
enum defined in Q14; `DEAD_LETTER` is never a report state.

### Q18 — The pinned demo target

**FROZEN: OWASP Juice Shop v17.3.0 (amd64), UNION SQLi in product search.** Validated live on 2026-08-25. Data-exfiltration path (not an auth bypass), so a seeded canary is directly observable in the HTTP response. One request, deterministic, no login.

| Field | Value | Verified |
| --- | --- | --- |
| Repository | `bkimminich/juice-shop` (source github.com/juice-shop/juice-shop) | ✅ |
| Version tag | `v17.3.0` (never `latest`; tags can be re-pushed) | ✅ pulled |
| Platform | `linux/amd64` — Daytona runs amd64; do NOT pin the arm64 variant | ✅ |
| Image (amd64 config digest) | `sha256:123acb31ed8bb05ebb06934a29be83d4e11a46cae937b9ed2bf2bda29d98130a` | ✅ inspected |
| Vulnerable endpoint | `GET /rest/products/search?q=` (raw string-concat in `routes/search.ts`) | ✅ source-checked |
| Exploit request | `q=qwert')) UNION SELECT id,email,password,'4','5','6','7','8','9' FROM Users--` (9 cols; email col 2, password col 3) | ✅ leaked 19 users |
| Canary | user registered per run via `POST /api/Users/` with an unpredictable email; never referenced in the PoC | ✅ registered |
| Oracle condition | that run's canary email appears in the search response JSON, evaluated **outside** the sandbox | ✅ oracle TRUE |
| Negative control | `q=apple` must NOT return the canary | ✅ passed |
| Second scenario | FROZEN — see Scenario 2 below | ✅ |
| Reset procedure | destroy the sandbox, boot a fresh container from the pinned digest; never reuse a run | ✅ |

**Toolchain: Apple `container` 1.0.0 on arm64 macOS (no Docker on this machine).**

Platform is the trap here, and it is now confirmed rather than assumed. Daytona's docs state *"Daytona expects the local image to be built for AMD64 architecture"* and that `--platform=linux/amd64` is required when your machine is a different architecture. This laptop is Apple Silicon, so a plain pull gives the **arm64** variant and pinning that digest means the image will not boot in the sandbox.

The Daytona mechanism for a custom image is a **Snapshot**: you register a snapshot by name against any publicly accessible registry image, by tag or by digest. So "boot the prebuilt pinned image" is, in Daytona's vocabulary, "create a sandbox from a snapshot pinned to a digest."

Digest captured (done):
```
container image pull --platform linux/amd64 bkimminich/juice-shop:v17.3.0
container image inspect bkimminich/juice-shop:v17.3.0   # amd64 config digest recorded above
```
When you build the Daytona **Snapshot**, pin it to the amd64 image above. Because TrueForge exposes no image field (Daytona-side only), the pin lives in the Daytona snapshot config, and you should record the snapshot's own digest there too.

Local runs on this machine are arm64 and are for building and rehearsing only. The demo's reproduction runs in the remote sandbox, so the sandbox's platform is the one that counts. Note also that Apple's `container` gives each container its own lightweight VM locally — better isolation than Docker's shared Linux VM, but irrelevant to the production sandbox decision, which is remote.

The second demo scenario lives inside this same target (Juice Shop has several injectable endpoints) — never a second target and never a second architecture. (This supersedes the earlier "spare target" idea, which conflicted with one-legal-target scope enforcement.)

**How the canary gets seeded:** Juice Shop re-seeds its database on boot, so the fixture does not touch the DB directly. It registers a normal user through the app's public registration endpoint with a random email, which lands in the Users table the UNION payload reads from. No database access, no image modification, and it re-seeds cleanly on every fresh sandbox.

**Target topology (demo vs production).** "The canary proves the exploit path" is only as strong as the isolation between the PoC and the canary:

- **Demo (one Daytona sandbox):** PoC, target and fixture share the sandbox; the PoC reaches the target on loopback and only sees the HTTP response. The fixture seeds the canary through the app's own registration API and the oracle reads the search response — the PoC never touches the DB or the oracle channel. This is what was validated. Honest caveat: they share a filesystem, so a PoC that broke out of the HTTP layer could read the canary directly; the demo does not exclude that.
- **Production:** separate containers — PoC container → target-only network endpoint → target container (protected state) → a host-side controller that seeds/resets/reads the oracle. The PoC has no path to the target DB, the fixture API, canary storage, or the oracle channel. Only then is "canary reached the trusted sink" proof rather than evidence.

**Scenario 2 (live backup, same pinned target) — auth-bypass SQLi in login.** Frozen and validated live 2026-08-25 against the same v17.3.0 amd64 image.

| Field | Value | Verified |
| --- | --- | --- |
| Endpoint | `POST /rest/user/login` | ✅ |
| Exploit request | `{"email":"' OR 1=1--","password":"x"}` | ✅ minted a JWT |
| Result | token for `id:1 / admin@juice-sh.op` (first user = admin) | ✅ decoded |
| Oracle condition | the injection's token opens an admin-only endpoint (`GET /api/Users` → 200), checked **outside** the sandbox — never the PoC's self-report | ✅ HTTP 200 |
| Per-run strengthening | register a canary user first; the admin-token `/api/Users` dump must contain that run's canary — ties the proof to a value the PoC can't precompute | recommended |
| Negative control | same login with a wrong password and no injection → `Invalid email or password` (401) | ✅ rejected |

Both scenarios run against the one pinned image; Scenario 2 is the live Backup C in the runbook. This is auth-bypass (a token you shouldn't get), where Scenario 1 is data-exfiltration (rows you shouldn't see) — two different vuln classes, one target, both deterministic.

**Why the canary is a seeded row and not a static string:** the PoC author knows Juice Shop's schema and could hardcode a plausible-looking email. An unpredictable per-run value they cannot guess, seeded by our fixture and checked by our instrument, is what makes "reproduced" unforgeable.

---

### Q19 — GitHub connectivity: OAuth login + GitHub App install (least-privilege)

**Two GitHub concepts, kept strictly separate (Vercel-style install model):**

- **OAuth login** ("Continue with GitHub") = operator **identity only** (Auth.js/OAuth). No broad repo scope; it authenticates the human, nothing more.
- **GitHub App installation** ("Install BountyDesk") = repo **connectivity**. An org/user installs the App and selects repos. The App carries built-in webhooks (a **platform-owned** signing secret — customers never see or paste it), granular permissions, and short-lived installation tokens.

**Flow:** Sign in with GitHub (identity) → Install BountyDesk App → choose org/account → choose repos → installation callback → store `installation_id` + repo IDs → a signed issue webhook arrives → verify / filter / process → human approves the exact verdict → a **short-lived installation token** posts the comment → discard the token.

**Minimum permissions (MVP):** **Metadata: read** (auto) + **Issues: read & write**. Explicitly **NOT** contents / actions / deployments / secrets / workflows / admin.

Amended 2026-08-27: the dynamic tier in Q20 downloads connected public repositories
anonymously, with no source token, and the demo fork is public. Contents: read is required for
private source. The intended private-repository policy accepts and triages a signed issue, then
refuses reproduction with `ANALYSIS_ONLY` and reason `POLICY_REFUSED`. That policy is designed,
not built: current GitHub intake requires a bound target profile, and repository visibility is
not stored. Adding a permission asks each installation owner to approve it. Installations that
do not approve continue with their old permissions, so existing issue intake does not stop.

**Token model — no stored PAT, no broad OAuth repo token.** To post a comment: authenticate the App → generate an installation access token (~1h TTL) → post the approved comment idempotently → discard the token. Nothing long-lived is persisted.

**Intake stays the same shape.** `POST /api/intake/github`, `X-Hub-Signature-256` (App webhook secret, platform-owned), `X-GitHub-Delivery` for idempotency, raw-body HMAC, 202 only after a durable commit. The App payload carries the installation, so BountyDesk resolves **`installation_id` → org → repo → TargetProfile server-side** — the issue/agent never supplies its own target.

**Intake policy (don't process every issue).** MVP = a **dedicated demo repo** (simplest). Alternatives: a BountyDesk Issue Form, or a configured `bountydesk` label (if label, handle `issues.opened` AND label events).

**Two new durable tables** (see UML): **GitHubInstallation** (installation identity + permissions + suspension) and **ConnectedRepository** (per-repo enablement, intake policy, and its `target_profile_id` link). GitHubInstallation 1:N ConnectedRepository; ConnectedRepository → TargetProfile (0..n:1). Security-sensitive, stored as columns, not JSON.

### Q20: Sandbox topology and the dynamic target tier (2026-08-27)

Tier 2 from Q2 moves into scope. A connected repository can be its own reproduction target:
the controller resolves an exact commit, downloads that commit, a build sandbox builds it, and
the reproduction runs against the immutable output. Dynamic does not mean "run the latest
code". Every reproduction uses an exact commit and an immutable build.

#### Build identity

Build identity is `repository id + commit SHA + source-archive digest + build-recipe digest +
base-image digest`. A matching successful build may be reused. Any changed input needs a new
build authorization.

#### Six security domains

The split matters more than the names, so each one is written as what it may reach rather than
what it is for.

1. The trusted controller resolves target authority, anonymously downloads the server-selected
   public source archive, and records its digest. It validates plans and
   capabilities, generates approval hashes, seeds the canary through the trusted fixture,
   evaluates the oracle, and owns teardown and reconciliation.
2. The disposable intake parser opens email bodies, attachments and uploaded files. It has no
   external network, no platform secrets, and no ability to create a target capability.
3. The untrusted build sandbox receives a source archive staged by the controller. It never
   receives a GitHub installation token, database URL, webhook secret, model key or Daytona
   key. Narrow dependency egress enforced by network policy rather than by asking. CPU,
   memory, process, disk and time limits. Produces a content-addressed artifact and cannot
   publish or authorise it.
4. The isolated target runtime runs the immutable build. It has no external egress and exposes only the
   approved application port to the PoC runner. Holds the state the fixture and oracle need.
5. The isolated PoC runner reaches only the target's approved endpoint. It has no access to target
   files, target database, fixture credentials, canary storage or the oracle channel. No
   platform secrets. Strict resource and execution limits.
6. The external oracle runs under the controller. It never trusts PoC stdout, exit status, or any
   file written inside a sandbox. Evaluates the application-specific canary contract and
   produces the authoritative result.

The demo puts target and PoC in one Daytona sandbox, so Q18's shared-filesystem caveat stands
and is demo-only isolation. Do not describe that topology as production-grade.

#### Egress by phase

The pinned demo builds ahead of time
and reproduces offline. A dynamic build gets narrow dependency access and cannot reach
arbitrary destinations, cloud metadata, private infrastructure or platform services. Dynamic
reproduction uses the immutable output, has no external egress, allows only the PoC-to-target
path, and fails closed if egress isolation cannot be verified.

#### Fixture requirement

No fixture means no `REPRODUCED`. Q3 requires a
defender-authored canary seeded through a trusted fixture. An arbitrary repository has none by
default, because nobody has written its seeding step or named its trusted sink. A profile
without an approved fixture, negative control and oracle adapter cannot produce a reproduced
verdict, whatever the PoC printed and whatever the model concluded from HTTP text, logs or
status files. That run produces the analysis-only packet and a human decides. An operator
promotes a dynamic target by writing a fixture and oracle into its profile, which is how the
Juice Shop profile got one. For another repository the agent may propose a startup contract,
fixture, canary seed, negative control, PoC execution and oracle observation; the server
validates the proposal against schema and policy, and a human approves it.

#### Three approvals

A build authorization comes before customer code executes. Its hash covers the profile id,
repository id, commit SHA, source-archive digest, build recipe, base-image digest, dependency
egress allowlist, build limits and teardown policy.

A reproduction approval comes after the build. Its hash covers the generated image digest,
snapshot id, build attestation, reproduction limits, PoC artifact digest, target port,
readiness contract, fixture, negative control, oracle adapter and teardown policy. A changed
artifact or plan invalidates the approval.

The outbound-verdict approval comes after the oracle result and evidence packet exist. It stays
content-hash bound as it already is.

#### Control status

"Designed" is not "built", and the difference is the only thing this table is for.

| Control | Enforced at | Status |
| --- | --- | --- |
| Opaque target capability | tools substitute profile values; no agent-supplied target | repository-to-profile binding built; capability tools designed and unbuilt |
| Separate build and reproduction sandboxes | two sandboxes per dynamic run, artifact crosses | designed |
| Mandatory egress enforcement | provider network policy, verified per run from inside | designed; the demo relies on the image needing no network, which is not the same thing |
| Server-validated agent proposals | schema and policy validation before human approval | designed |
| Hash-bound approval | `publish_verdict` refuses a differing content hash | schema built, logic unbuilt |
| External oracle | controller-side, outside the PoC environment | designed |
| No secrets in the hostile runtime | neither sandbox receives any platform credential | designed |
| Resource limits | CPU, memory, process, disk, wall clock, teardown by TTL plus reconciler | designed |

### Q21: Independent intake channels (2026-08-27)

Intake and reproduction are separate concerns, and conflating them is what made the earlier
docs read as GitHub-only. A report enters through a channel. Reproduction needs a
server-authorised target profile. Neither implies the other.

Three channels, independent of one another:

- GitHub issues: verify the webhook signature, resolve installation and repository ids
  server-side, attach the configured profile when one exists. A repository not configured for
  reproduction is handled by the documented channel policy, and a target is never inferred
  from issue text.
- Email: verify the provider's webhook signature. Sender, headers, body, links and
  attachments are untrusted, and sender identity is never target authorisation. Needs no
  GitHub connection to create a report.
- File upload: require an authenticated platform user. Filenames, MIME declarations,
  archives, documents, source files and PoCs are untrusted. Needs no GitHub connection.

A report with no bound profile is triaged and moves to `ANALYSIS_ONLY`. Nothing is cloned,
built, deployed or probed. Resuming reproduction after a reviewer later binds a profile needs
a future `ANALYSIS_ONLY → REPRODUCING` transition and transition tests; the current state
machine does not permit it. An uploaded repository archive or a clone URL in a message is
never an authorised target. Promoting uploaded source into an executable target would be a
separate onboarding workflow with human authorisation, immutable hashes, safe extraction,
build isolation and a server-created profile.

`manual` is the upload channel. The `intake_channel` enum already carries `github`, `email` and
`manual`, so there is no migration; a dedicated `upload` value can come later if it earns
itself.

#### Intake parsing controls

Designed, not built: no external network, no platform secrets,
file-size limits, attachment-count limits, content-based MIME detection, archive-depth limits,
maximum decompressed size, path traversal rejection, symlink rejection, parser timeouts, CPU
and memory limits, process-count limits, sanitised rendering, immutable artifact hashes, and
malware scanning where available.

#### Delivery

Only GitHub has a defined outbound adapter. Email and upload delivery remain undecided and
unbuilt. An operator checkbox is not proof of external delivery and must not create a
`DeliveryAttempt` or move a report to `DELIVERED`. A later channel contract must define a
verifiable recipient and transport receipt. Until then, those reports may be denied, cancelled
or expired through the existing lifecycle, but cannot claim delivery.

### Implementation gates (2026-08-27)

Written down because several of the sections above describe intent, and intent read as status
is how a demo dies.

Not built: a Daytona provisioning client, the real `AnalysisDriver`, any email or upload
route, the dynamic build pipeline, the external oracle. `DAYTONA_TARGET_SNAPSHOT_ID` is still
a placeholder and must not be described as configured until a real immutable identifier has
been verified. TrueForge's Daytona provider showing `ready` proves a provider is configured;
it proves nothing about image pinning, offline execution, snapshot selection, or that the
BountyDesk target snapshot exists.

Known code gaps that this architecture collides with. `report.target_profile_id` is nullable,
but `ensureReport()` and GitHub intake currently require a profile, so targetless intake needs
a code change before it can exist. `connected_repository` does not retain trusted repository
visibility, so the public-source policy cannot distinguish a private repository after intake.
Persist visibility from authenticated GitHub lifecycle data rather than from report text. The
current report state machine also rejects `ANALYSIS_ONLY → REPRODUCING`, so binding a target
later needs a new transition and transition tests. `target_profile.image_digest` is `NOT NULL`,
while `lib/targets/configure.ts` hardcodes the official upstream Juice Shop digest and asserts
an exact match on conflict. That digest
does not establish provenance for an image built from the connected fork. A dynamic profile
has no generated image digest until its build finishes, so the data model must either separate
source identity from runtime artifact identity or record the built digest per run. The spike
answered where Daytona exposes the immutable artifact: nowhere, and an unprivileged container
cannot read it either. So the data model has to separate the two, carrying source identity on
the profile and recording the digest observed by the build that produced the artifact, with the
snapshot's digest-pinned `imageName` checked at provisioning time.

#### Analysis driver gate

Do not add a real `AnalysisDriver` until a provisioning spike passes. The spike must prove that
BountyDesk can provision the environment; that a `TargetProfile` selects the exact snapshot;
that the connected commit corresponds to the built artifact; that the amd64 digest verifies;
that the target starts with no runtime downloads; that build egress is restricted and
reproduction egress is blocked; that cloud metadata endpoints are unreachable; that resource
limits hold; that TTL and reconciliation destroy abandoned sandboxes; that the agent can reach
only the provisioned target; and that the controller can seed and evaluate the oracle without
exposing that channel to the PoC. A failure at any gate produces `ANALYSIS_ONLY` with an
infrastructure reason, never `NOT_REPRODUCED`.

#### Spike result, 2026-08-27

The first gate is cleared. `lib/sandbox/daytona.ts` provisions from a named snapshot, reads
back what booted, runs a fixed command inside it, shows from inside that the sandbox reaches
nothing, and destroys it; a second delete is a no-op and the sandbox then 404s. Full evidence
is in [`spikes/2026-08-27-daytona-provisioning.md`](./spikes/2026-08-27-daytona-provisioning.md).

Four provider facts change what the gates above can mean.

Resource limits cannot be requested. Daytona rejects a create that carries cpu, memory or disk
alongside a snapshot, so those are fixed when the snapshot is built. "Resource limits hold" is
therefore verified against the snapshot record before provisioning, not asserted in the
request, and a snapshot that declares no limits is refused rather than trusted.

Egress is blocked by an interception proxy rather than by an absent route. The sandbox has a
default route and a resolver; requests leave and an Envoy answers 403. Nothing reached its
destination and no metadata credentials came back, but the property belongs to Daytona's policy
engine rather than to the shape of the network, so it is verified from inside on every run. A
blocked request is a successful HTTP transaction, so the check reads the status line: a 2xx or
3xx is the destination answering, which is the failure.

There is no resolved image digest in the API. Neither the snapshot nor the sandbox response
carries one, and nothing digest-shaped exists in the OpenAPI document except Daytona's own
build SHA. Nor can an unprivileged container read the manifest digest the host runtime used, so
the sandbox cannot establish its own provenance either. What replaces "the amd64 digest
verifies" is a chain: build outside and record the generated digest there, create the snapshot
from a digest-pinned `image@sha256:…` reference, require the snapshot record's `imageName` to
equal that reference exactly at provisioning time, and verify a defender-authored build marker
inside the running target. The marker proves the artifact came from our build, not that the
manifest digest matched. That last step is residual trust in the provider and is documented as
such rather than dressed up as verification.

Teardown is not immediately available. A just-started sandbox answers `DELETE` with 409, and
the first version of this spike leaked one exactly that way. `deleteSandbox` retries with
backoff, which makes it best-effort rather than a guarantee, so the provider TTL and a
reconciler are load-bearing rather than defence in depth. Neither the TTL expiring on its own
nor the reconciler has been exercised, so "destroy reliably" is not yet a claim this evidence
supports.

Reasons recorded beside `ANALYSIS_ONLY`, none of which are report states: `NO_BOUND_TARGET`,
`COULD_NOT_BUILD`, `COULD_NOT_DEPLOY`, `NO_APPROVED_ORACLE`, `TARGET_UNAVAILABLE`,
`POLICY_REFUSED`, `INTAKE_PARSE_FAILED`.

#### Digest check and rotation, 2026-08-27

A review of the pre-existing target-configuration code (`lib/targets/configure.ts`,
`configure-request.ts`, from the settings-screen work, not this spike) found the digest-pinned
image chain above was written down but not enforced, and found two related gaps. All three are
fixed now.

`createSandbox` takes a new required `imageRef`, a `registry/name@sha256:<64 hex>` reference,
and refuses both a spec whose reference is not digest-pinned and a snapshot whose `imageName`
does not equal it exactly, before provisioning. A missing `imageName` counts as a mismatch, the
same way a missing resource limit does. There is still no real digest-pinned image to check
against: the connected fork has not been built yet, so this closes the gap in the client rather
than in the deployed target.

`configureJuiceShopTarget` refuses to bind a repository to a profile with different pinned
settings than the one already stored, which is correct as a guard against accidental drift but
gave no way to move to a verified new build on purpose. `rotateJuiceShopTarget` is the explicit
path for that: it updates the existing row's digest, snapshot id, config and scope rules in
place, keyed by the same fixed profile name, and refuses if no profile exists yet rather than
creating one. `rotateRepositoryTargetRequest` wraps it behind the same reviewer allowlist and
the same fail-closed environment read as configuring.

`configureRepositoryRequest` and `scripts/seed-target.ts` both fell back to a bundled digest
(`sha256:123acb…`, which `env.example` already flags as upstream's image, not the fork's) when
`DAYTONA_TARGET_IMAGE_DIGEST` was unset. Both now fail closed instead: a missing digest or
snapshot id refuses the request rather than silently pinning against an artifact nobody chose.

---

## Product-hardening batch (demo / production)

1. **Attachment & artifact safety.** Demo: cap total bytes + file count on intake, don't unpack archives, in the case file escape terminal control codes + strip invisible/bidi Unicode + never render raw HTML, redact auth headers, store by content hash. Prod: MIME validation, zip-bomb/path-traversal scanning, signed downloads, truncation-with-marker.
2. **Reviewer auth.** Demo: one reviewer behind the app login, approval single-use + content-hash bound. Prod: tenant-membership RBAC, approver-identity audit.
3. **Multi-tenant data model.** Demo: single tenant/program/TargetProfile, but add `TargetProfile` + `ScopeRule` now and a nullable `tenant_id` column everywhere. Prod: Organization/User/Membership/Program/ChannelConfig, `tenant_id` enforced, secret references not plaintext.
4. **Budgets / rate limits / kill switch.** Demo: per-source intake rate limit (also closes manual-paste abuse), per-report turn/token cap, manual worker kill switch. Prod: per-tenant quotas, sandbox quota, max-queue-age shedding.
5. **Secrets.** Demo: keys in server env on the host, settings page behind login. Prod: encrypted-at-rest, rotated, tenant-scoped secret store.
6. **Outbound delivery.** Post the GitHub comment through an `outbox` / `DeliveryAttempt` row with an idempotency key so a failed post retries without double-commenting.

---

## Board changes made this session (Figma K6z2IqS3ep6EtlriSWp8CE)

**Round 1 — targeted fixes**
- UML page: removed 10 FigJam starter-template nodes and 5 orphaned connectors.
- Concurrency: corrected the capacity claim and labelled the figures unvalidated.
- Threat Model: added the demo-Daytona vs production-Kata caveat and the heredoc-injection correction.
- New page "9 · Analysis Fallback" and new page "Build Decisions".

**Round 2 — full reconciliation (after the second audit found two competing architectures on one board)**

Every older page was rewritten to the decided architecture, then scanned for retired phrases until clean:

| Page | What changed |
| --- | --- |
| 8 · Deployment Topology | Vercel + private :8790 → one host, HTTPS 443 the only public surface, harness on loopback, SSE proxied server-side |
| Technical Flow | uniform HMAC → per-channel authenticator fail-closed; TTL cache → durable job row decided by state, 202 before parse; delivery → outbox + DeliveryAttempt; section C → prebuilt image, canary oracle, staged-as-file |
| 3 · Daytona Sandbox | clone + npm ci + /health → boot prebuilt pinned image offline; heredoc → filesystem API; 512 MB → documented 1 GiB minimum; root/RO-mount claims marked contradicted; exit code → oracle; teardown → TTL + reconciler |
| 2 · TrueForge Server | custom checkpoint → native pending tool call; resume → new chained turn with user.tool_approval; added the cancels-running-turn warning |
| 1 · Next.js App | seen-store → durable job; sessions.create → create + createTurnStream; Allow/Modify/Reject → Modify-in-form then native Allow/Deny |
| 7 · Sequence | session BLOCKED → PENDING tool call; resume → new chained turn; delivery → DB txn then worker |
| 5 · Sandbox Runner Agent | version inference + default-branch fallback → server-side TargetProfile; exit-code verdict → oracle result; added negative control |
| Flow diagrams | semantic duplicates no longer auto-close; pinned target; native Allow/Deny |
| Tech Stack | one host, private harness, idempotent delivery worker |
| 6 · Concurrency | pool/shedding marked PRODUCTION; demo is one worker at concurrency 1 with leases and a sweeper |
| 4 · Threat Model | every row tagged DEMO (implemented) or PROD (target) |
| 9 · Analysis Fallback | "what ships" → "what is prepared for review"; duplicate split into delivery replay vs semantic similarity |
| Build Decisions | atomicity claim replaced with the staged approve → DB txn → delivery worker sequence |

**UML — full model.** Added InboundJob, TargetProfile, ScopeRule, DeliveryAttempt, SessionEvent, Artifact, VerdictRevision, ApprovalDecision, ReporterReply (cloned from the existing table component so styling matches). Report gained `tenant_id`, `trust_level`, `target_profile_id`; Verdict gained `state`; Report→Session and Report→DedupeIndex corrected to 1 : 0..n. Added a legend explaining what each new table is for.

**Round 3 — second-audit reconciliation (Codex).** Confirmed the submission is BountyDesk (Sentinel was a throwaway prototype; BountyDesk starts fresh with Qodo PRs from commit one, which resolves the eligibility gate). Applied:
- **Q18 target FROZEN and live-verified** — Juice Shop v17.3.0 amd64, digest, endpoint, 9-column UNION payload, canary via registration API, oracle, negative control — all validated on hardware 2026-08-25. Runbook's target reference reconciled.
- **Canary topology** documented — demo (shared sandbox, honest caveat) vs production (separated PoC/target/oracle).
- **Prebuilt ≠ offline** corrected on Deployment + Threat Model: a prebuilt image removes the NEED for network; it does not block it. TrueForge enforces no egress (verified) — Daytona egress is demo-validated, not trusted.
- **Fallback wired into the flow** — Sandbox Runner now shows NOT_AUTOMATABLE / TARGET_UNAVAILABLE → ANALYSIS_ONLY → evidence packet → human. Obsolete "What ships" subtitle deleted from the Analysis Fallback page.
- **Flow leftovers fixed** — "request more info" → AWAITING_REPORTER; semantic-duplicate no longer auto-rejects (delivery replay vs semantic similarity split on both the main flow and the Triager diagram); folder intake clarified as a server-side path; deny → redraft-as-new-turn.
- **Impossible Modify branch fixed** — native decision is Allow/Deny only; Deny → edit in a form → a NEW gated publish_verdict call. Runbook step 8 rewritten to the pending-call → new approval turn → DB/outbox → delivery-worker sequence.
- **UML outbox split** — added OutboundDelivery (durable publication intent + state) distinct from DeliveryAttempt (1:N attempt history); retired legacy varchar[]/jsonb[] fields (evidence_files, messages, checkpoint) in favour of Artifact and SessionEvent.

**Verification.** Every page was scanned for the retired phrases (`seen-store`, `TTL 24h`, `Allow / Modify / Reject`, `npm ci`, `git clone`, `poll /health`, `8790`, `Vercel`, `heredoc`, `MemoryMax 512M`, `BLOCKED_ON_APPROVAL`, `2.5N`). Remaining matches are intentional: the Threat Model caveat that explains why heredoc is not a boundary, and the Concurrency note that explains why 2.5N was dropped.

---

## Deferred (real product, not the hackathon)

- Black-box / live-target reproduction path for non-self-hostable scope.
- Full RBAC, multi-tenant enforcement, encrypted secret store.
- Dedupe feedback loop with held-out audit sample (only human-confirmed outcomes feed it).
- CVSS/severity as human-signed-off only; researcher appeal path.
- Attachment MIME/zip-bomb hardening; signed artifact downloads.

---

## Current implementation sequence

The Qodo-reviewed PR trail, target choice and two demo scenarios are frozen. The remaining work is
ordered with explicit exit criteria in [`plan.md`](./plan.md); that plan supersedes the original
session's immediate-action checklist.
