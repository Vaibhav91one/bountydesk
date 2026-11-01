# Live-target reproduction (#325)

Design record for reproducing a report against a host BountyDesk does not build or run. This is the
design document issue #325 requires before any code. It commits to nothing. Where a statement is a
guess it says so. Background: `docs/research/325-live-target-ownership.md` (how other products prove
ownership), `docs/decisions.md` Q33 (the ownership design record), and
`docs/design/parked-issues-343-327-325-354.md` (ordering).

## Goal and non-goals

Goal: let a reviewer bind a live URL they control as a `TargetProfile`, and let BountyDesk send a
small, bounded set of requests to it so that a report can reach `REPRODUCED` or `NOT_REPRODUCED` on
the same oracle rules as an offline run, or stay `ANALYSIS_ONLY`.

Non-goals:

- Scanning. No nuclei, sqlmap, ZAP or crawler runs against a live host. That is the workbench
  (`docs/pentest-workbench.md`, #327) and it stays offline.
- Hosts the reviewer does not control. A bug bounty program's production site is out of scope even if
  the program allows testing, because BountyDesk cannot prove the reviewer speaks for it.
- Weakening any invariant in `AGENTS.md`: the human gate on `publish_verdict`, the content-hash lock,
  scope bound server-side, and "no bound target, no `REPRODUCED`".
- Self-hosted use. Q33 already makes live-target mode a hosted-only capability.
- A new verdict value. The `verdictOutcome` enum in `lib/db/schema.ts` is unchanged.

## What exists today

The pieces below are verified on main. The design reuses them rather than adding parallel ones.

- `lib/targets/external-target.ts` models an external target (`ExternalTargetConfig`: `baseUrl`,
  `egressHosts`, `seedable`), rejects loopback and embedded credentials, and states the rule that an
  external target cannot carry a canary-backed `REPRODUCED` unless `seedable` is true
  (`externalTargetCanReproduce`). Its header says the live routing is a separate integration. The
  probe path does not call it yet.
- `lib/mcp/probe-target.ts` forwards `probe_target` (GET/HEAD) and `probe_target_write` (POST) to the
  run's sandbox and re-checks the repository grant (`hasActiveRepositoryGrant`) at call time.
- `lib/agent-sessions/poller.ts` auto-approves `probe_target_write` (`autoApproveWriteProbe`) because
  the only reachable network is the offline sandbox. Q33 says this must not extend to a live host.
- `lib/scope-guard/egress.ts` is the connect-time egress path for `http_probe` and `tcp_probe`. It
  dials the address `Scope.check()` validated (`connectAddress`) instead of resolving the hostname a
  second time, which closes the DNS-rebinding gap between check and connect. `lib/scope-guard/scope.ts`
  hard-denies cloud metadata and link-local space.
- `lib/scope-guard/audit.ts` is a Postgres, hash-chained, append-only audit log (`scopeGuardAudit`).
  `lib/scope-guard/grants.ts` mints single-use, target-bound grants (`scopeGuardGrant`) for
  `request_intrusive_approval` and `verify_grant`.
- `lib/sandbox/daytona.ts` has a narrow-egress sandbox for builds (`domainAllowList`, with
  `assertOrganizationEgressRestricted` proving the restriction took effect). Reproduction sandboxes use
  `networkBlockAll` and `verifyNoEgress` (`lib/sandbox/provision.ts`).
- `lib/reproduction/decide.ts` (`decideOutcome`) and `lib/sandbox/reproduce.ts` (`createReproducer`)
  run the fixture, negative-control and exploit legs. `lib/targets/authorize-reproduction.ts` returns
  `NO_BOUND_TARGET` or `NO_APPROVED_ORACLE` when a run must not proceed.
- `lib/targets/quarantine.ts` drops reports bound to a stale profile to `ANALYSIS_ONLY`.
- `lib/build-onboarding/source-identity.ts` (`hasIdentityAnchor`) accepts a commit SHA, source archive
  digest or image digest as a target's identity.

Two facts the earlier plan in the issue thread did not carry. Issue #361 (the Q33 implementation) is
closed, but only the design was merged: there is no ownership-proof code on main. And issue #326 is
closed, but `lib/db/schema.ts` has no tenant, organization or secret-store table. Both feed the owner
decisions below.

## The central difficulty

Every control in the offline path rests on one fact: the sandbox has no route out, so nothing it does
can reach a third party. A live target removes that fact. The replacement is not a weaker version of
the same wall. It is a different control: BountyDesk itself, not the sandbox, sends every request, to
one proven host, through one code path that checks scope, rate and approval before it opens a socket.

## Ownership proof

Mechanism (from Q33, with the details this document adds):

- When a reviewer claims a host, the server mints a token of at least 128 bits and stores it against
  the profile. The host and the token are the claim.
- Two methods. A DNS TXT record `bountydesk-verification=<token>` on the host, or a file at
  `/.well-known/bountydesk.txt` whose entire body is the token. The file method exists for hosts on
  shared platforms where the owner cannot edit DNS. A DNS proof on an apex covers subdomains only if
  the owner opts in when claiming; a file proof covers only the exact origin it was served from.
- The challenge is bound to the profile and host. The server keeps `sha256(profileId || host || token)`
  as the expected value, so a token copied from another profile's page does not verify. (Guess: the
  extra binding matters little against an attacker who cannot read the token, but it costs one hash and
  removes a class of copy mistakes.)
- File fetch rules: HTTPS only, no redirects off the claimed host, a 4 KiB body cap, a short timeout,
  and the same resolve-then-pin path as probes. The resolved address is checked against private,
  loopback, link-local and metadata ranges before any byte is read. A file served by a CDN in front of
  someone else's origin is a known weakness (research doc, section 4); the address pin limits the
  damage but does not remove it.
- Re-verification runs immediately before every live run and again on a short cadence while the run is
  active (guess: every 5 minutes). A failed re-check stops the run.
- Expiry is 30 days from the last successful verification, per Q33. The research doc found no surveyed
  product that documents a fixed window, so 30 days is a guess carried over from Q33, not a finding.
- Verification attempts are rate limited per profile (guess: 10 an hour), so the check cannot itself
  be used to hit a host.
- Revocation. A reviewer can revoke at any time. The host owner revokes by removing the record, which
  the next re-check notices. BountyDesk can revoke on an abuse report. Revocation sets `revoked_at`,
  ends active runs, and drops reports bound to the profile to `ANALYSIS_ONLY` through the path
  `quarantineStaleTargetProfile` already uses. A revoked proof is never revived; a new claim mints a
  new token.

## Binding a live host without weakening the invariant

The invariant is "no bound target, no `REPRODUCED`", and Q33 already amends what counts as bound: a
profile with a current, re-verified proof. This document makes that concrete.

- A live-host profile is a `TargetProfile` whose `config.external` block parses with
  `parseExternalTarget`, plus a proof record. It is created through `configureConnectionlessTarget`
  (`lib/targets/configure.ts`) in a new external branch, by a reviewer with the `member` role. Nothing
  the agent or the report says can create or alter it.
- Authorization is a function the server evaluates at run start and again at verdict persistence,
  next to `hasActiveRepositoryGrant`: proof present, not expired, not revoked, last re-check passed,
  resolved address still equal to the pin. If any term is false the target is not bound and the
  existing refusal path applies (`NO_BOUND_TARGET`; `persistAgentDraftedVerdict` in
  `lib/mcp/publish-verdict.ts` refuses a claimed `REPRODUCED` or `NOT_REPRODUCED`).
- Identity. A live host has no commit SHA or image digest, so `hasIdentityAnchor` would reject it.
  Proposal: do not stretch `hasIdentityAnchor`. Add a separate `hasLiveTargetAnchor` that requires the
  proof, the pinned address set, and the TLS leaf certificate fingerprint recorded at bind time. The
  `imageDigest` column on `target_profile` is `notNull`, so a live profile stores a fixed sentinel and
  application code treats the live anchor as the identity. (Guess: leaf fingerprint pinning will
  produce false alarms on ordinary certificate renewal. The alternative is to pin issuer and subject.
  Listed as an owner decision.)
- Drift. A live host changes without notice. Each run records the address, certificate fingerprint and
  proof version it used. If those differ from the bound values the run stops and reports
  `ANALYSIS_ONLY`; it does not rebind silently.
- What a live run proves. A live host is neither isolated nor immutable, so its label is
  `external-non-isolated` (`isolationLabel`), shown on the verdict and in the UI. The verdict says the
  result is against a live system at a point in time.

## What runs

Only the oracles #343 defines, executed by the existing reproducer, never free-form agent traffic.
That is the main bound on blast radius: a server-authored recipe fixes the set of requests, and the
agent chooses which recipe, not what to send.

- Read-only by default. A recipe run on a live host may use GET and HEAD only. A recipe with a write in
  any leg is not runnable by default.
- A recipe is runnable against a live host only if its author marks it live-safe in code. The flag is
  separate from the existing oracle-ready check and defaults to not live-safe. (Guess: most injection
  recipes that seed a canary through a registration endpoint will not be live-safe, and for them the
  answer is `ANALYSIS_ONLY`.)
- Write probes need explicit opt-in per run. The reviewer names the recipe, the server shows the exact
  request list, and the opt-in is stored on the run and expires with it. It is not a profile setting
  and it is not remembered. `probe_target_write` against a live profile never takes the auto-approve
  path: a live-profile check goes in front of `autoApproveWriteProbe` in `poller.ts`, and the call
  falls through to a human Allow or Deny, the same gate `publish_verdict` uses.
- Canary seeding. The offline oracle seeds a canary through a trusted fixture. On a live host that
  means writing data to someone's system, so a recipe whose fixture leg writes needs the write opt-in.
  If the profile declares `seedable: false`, no canary-backed outcome is possible and the run is
  `ANALYSIS_ONLY`. A passive-read oracle (the response itself carries an unmistakable server-side
  marker) is the only live-safe shape, and #343 does not define one yet. This is why #343 comes first.
- Outcome rules do not change. `decideOutcome` still needs the fixture, negative control and exploit
  legs to complete, and a dirty control gives `ANALYSIS_ONLY`.
- Ad hoc agent probes (`probe_target` GETs outside a recipe) are left to the last phase. Until then
  the live path runs recipes only.

## Egress path

There is no throwaway sandbox for the target, so the question is where requests come from.

- Origin: a BountyDesk-controlled relay, not a Daytona sandbox. The sandbox never needs a route to the
  live host, so it keeps `networkBlockAll` and `verifyNoEgress`. This avoids putting a DNS allowlist
  on an agent-reachable sandbox, which was the plan in the issue thread. (Guess: this is the better
  option because it keeps the strongest existing control intact. The cost is that BountyDesk's own
  infrastructure becomes the component that reaches third parties, so it needs its own limits and
  isolation from the rest of the app.)
- Fixed egress IP. Live probes leave through one small service with a static address, separate from the
  main web process. Owners can allow that address on their firewall, and an abuse report can name it.
  Where it runs is unsettled (guess: a single small VM or container with a reserved IP, depending on
  the hosting choice in `docs/deployment.md`).
- Connect-time pinning. The relay uses the `lib/scope-guard/egress.ts` approach: resolve once, validate
  the address against private, loopback, link-local and metadata ranges, dial that address, keep the
  hostname only for Host and SNI. Redirects are not followed; a redirect response goes to the oracle
  as a response and is never fetched.
- Request shaping. A fixed User-Agent that names BountyDesk and an abuse contact, plus a header
  carrying a run id, so a host owner can find a run in their logs.
- Limits, all server-side and per run (numbers are guesses to tune): 60 requests total, 2 requests per
  second, 1 in flight, a 10 second per-request timeout, a 1 MiB response cap, a 10 minute wall clock.
  A second limit per host across runs (guess: 600 requests an hour) so repeated runs cannot stack up.
- Kill switch at three levels: per run (a reviewer button and an abort the relay checks between
  requests), per profile (revocation), and global (one flag that makes the relay refuse every live
  request, effective without a deploy).

## Scope rules and server-side enforcement

Scope is the single origin in `config.external.baseUrl`, resolved to the pinned address set. Anything
else is denied.

- The capability boundary builds the scope from the profile row. The agent supplies a capability token
  and a same-origin path, never a host or URL, as `probe_target` already requires.
- `egressHosts` in `ExternalTargetConfig` is the only widening, and for a live host it must be empty
  unless the extra host carries its own proof. (Guess: the staging-oriented meaning of `egressHosts`,
  extra hosts a stack needs, does not apply to a live host, and Phase 1 should reject it for live
  profiles.)
- `scope_add_temporary` (in `app/api/mcp/scope-guard/route.ts`) must refuse for a session bound to a
  live profile. Runtime widening is how an agent escapes its scope, and XBOW's published design
  forbids it (see `docs/pentest-workbench.md`).
- Every request is checked in this order: run active and not killed, proof current, address equals the
  pin, path is in the recipe's request list, method allowed at the current opt-in level, budget and
  rate not exceeded, then dial. A failure at any step denies the request and writes an audit row.
- The recipe's request list is the path allowlist. A path not in the list is denied even if it is on
  the proven host. (A pattern deny list for logout or delete paths would be weak; the allowlist is the
  real control.)
- Domain deny list: government, military and large-platform domains cannot be claimed (Q33). It is a
  table, checked at claim time and again at run start.

## Abuse handling and audit

- Every live request goes to `scopeGuardAudit` through `lib/scope-guard/audit.ts` with actor, run id,
  profile id, method, path, response status, byte count, and the allow or deny reason. Bodies are
  stored as a hash plus a capped excerpt (guess: 4 KiB), so the log answers "what did you send"
  without holding the target's data indefinitely.
- Retention for live-request audit rows is a legal question; see the owner decisions. Until decided,
  rows are kept.
- A published abuse contact appears in the User-Agent. An abuse report puts the profile into a held
  state, revokes the proof, and stops active runs; then a human reviews.
- Misuse signals: repeated failed proof attempts, many hosts claimed from one account, a complaint from
  a host owner. Each is recorded. Thresholds are a guess for the owner to set.
- Accountability: the claim, the write opt-in and the revocation each store the acting reviewer id.
  `reviewerRole` has `member` and `read_only`; only `member` may claim, opt in or revoke.

## Failure modes

- Proof expires or is removed mid-run: the next re-check fails, the relay refuses further requests, and
  the run ends `ANALYSIS_ONLY` with partial evidence marked incomplete.
- Address changes (DNS flip or rebinding): the pin no longer matches, the run stops. No silent rebind.
- Certificate changes: stop and require a re-bind.
- The host blocks or throttles BountyDesk (429, WAF page, connection resets): this is not evidence. The
  run is `ANALYSIS_ONLY` with a reason, never `NOT_REPRODUCED`, because a blocked request would
  otherwise look like a clean negative control.
- The target is down or slow: same. A live system being down is not a negative result.
- Target data changes between legs: the run records response hashes of a baseline request at start and
  end, and a mismatch marks the run unstable and gives `ANALYSIS_ONLY`. (Guess: this will trip on pages
  with timestamps, so the baseline needs a per-recipe comparison, which is more design.)
- Relay crash mid-run: a run that cannot show a clean close is `ANALYSIS_ONLY`. The request counter is
  stored in Postgres, not memory, so a restart cannot reset the budget.
- Revocation while a write opt-in is pending: the opt-in dies with the run.
- A response contains instructions aimed at the agent: responses are untrusted input, as the
  oracle-boundary comment in `lib/reproduction/types.ts` says. The oracle reads the response in the
  controller; the agent sees only what the reproducer returns.

## Data model proposal

A proposal, not a migration. `target_profile.config` (jsonb) already carries the external block, but
the proof needs queries ("which proofs expire this week", "revoke all for host X") and a history, which
jsonb makes awkward. Proposed:

- `live_target_proof`: `id`, `target_profile_id` (fk), `host`, `method` (`dns_txt` or `well_known`),
  `proof_scope` (`exact` or `apex_with_subdomains`), `token_hash`, `verified_at`, `expires_at`,
  `last_recheck_at`, `last_recheck_ok`, `pinned_addresses` (text[]), `cert_fingerprint`, `revoked_at`,
  `revoked_by`, `revoked_reason`, `created_by`, `created_at`. One current row per profile; a re-claim
  inserts a new row, so history is kept.
- `live_target_run`: `id`, `investigation_run_id` (fk), `target_profile_id`, `proof_id`, `write_opt_in`
  (boolean, default false), `opt_in_by`, `request_budget`, `requests_used`, `killed_at`, `killed_by`,
  `started_at`, `ended_at`, `end_reason`.
- `live_target_deny_domain`: `pattern`, `reason`, `added_by`, `added_at`.
- Enums: `live_proof_method` and `live_proof_scope`. The alternative is text with a check constraint,
  which the repo uses for state machines that change often (see the comment near `approval_submission`
  in `lib/db/schema.ts`). Proof methods change rarely, so an enum fits.
- Existing tables: `verdict_outcome` is frozen. `target_profile.origin` is free text and gains the
  value `live`. The isolation label is derived from the config, not stored.
- Audit: live requests reuse `scopeGuardAudit`, with `action` values `live_probe` and
  `live_proof_check`. No new audit table. (Guess: filtering on `action` is enough.)
- Tenancy: if the owner requires tenancy first, every table above gains an owner scope column. With no
  tenant tables on main today, the proof and run tables would be global.

## Phased plan and test gates

Each phase ends at a stop point where the owner can decide whether to continue. Security-sensitive
surfaces land with adversarial tests in the same PR, not after.

- Phase 0 is this document. Exit: the owner answers the decisions below.
- Phase 1, proof only, no traffic to live targets beyond the proof fetch. `live_target_proof` and the
  deny-domain table, `lib/targets/ownership-proof.ts` (mint, verify, re-verify, revoke), claim and
  revoke routes with the `member` check, the external branch of `configureConnectionlessTarget`, and
  quarantine of expired proofs. Test gate: unit tests for challenge format and expiry. Adversarial
  tests: a proof for host A does not verify host B; a token from another profile fails; a well-known
  response that redirects off the host is rejected; an oversized body is rejected; a proof fetch that
  resolves to 127.0.0.1, 10.0.0.0/8, 169.254.169.254 or `metadata.google.internal` is rejected; a DNS
  answer that changes between check and connect is not followed; a revoked proof is never accepted
  again.
- Phase 2, relay and read-only recipe runs. The relay with a fixed IP, budgets, rate limits and kill
  switches, `live_target_run`, audit rows, `hasLiveTargetAnchor`, the live-safe recipe flag, and the
  refusal of `scope_add_temporary` for live sessions. Outcome rules unchanged. Test gate: a request to
  any host other than the pinned one is refused; a redirect is not followed; budget exhaustion, rate
  limit and wall-clock expiry each stop the run; the global kill flag stops a run in flight; a restart
  does not reset the counter; a 429 or WAF response yields `ANALYSIS_ONLY`, never `NOT_REPRODUCED`; the
  agent cannot widen scope through any scope-guard tool; a proof that expires between request N and N+1
  stops N+1. Gate for turning it on: one end-to-end run against a host the owner controls, with that
  host's server logs matching the recorded requests exactly.
- Phase 3, write opt-in. Per-run opt-in storage and UI, the live-profile guard in front of
  `autoApproveWriteProbe`, and write-capable recipes marked live-safe one at a time. Test gate:
  `probe_target_write` on a live profile never reaches `autoApproveWriteProbe` (asserted in the poller
  tests); an opt-in for recipe A does not authorize recipe B; an opt-in does not survive the run; a
  `read_only` reviewer cannot opt in; a write whose path or body differs from the approved list is
  refused; offline profiles still auto-approve (regression test).
- Phase 4, ad hoc agent probes and anything broader, only if Phases 2 and 3 show value.

Order relative to other work: after #343 produces a recipe shape that can run on a live host (at
minimum a passive-read oracle), and after the Q33 operational controls (kill switch, rate cap, request
log, deny list, revocation) exist. Phase 1 can run in parallel with #343 because it sends no oracle
traffic.

## Decisions for the owner

1. Legal exposure. Sending requests to a host BountyDesk does not control, for a user who claims to own
   it, creates liability if the claim is wrong or the proof is subverted (a CDN in front, a shared host,
   a compromised DNS record). Does counsel need to review the terms of use, an indemnity from the
   claimant, and a reviewer attestation before Phase 2 ships? Should the first release accept only DNS
   proofs, which are stronger than the file method?
2. Abuse handling. Who receives abuse reports, what is the response time, and who may revoke a proof
   unilaterally? Is a published User-Agent and fixed egress IP acceptable, given that it makes BountyDesk
   traffic easy to attribute and to block?
3. Proof revocation and expiry. Is 30 days right? Does removal of the record by the host owner revoke at
   the next re-check? May someone other than the first claimant claim the same host, and under what
   conditions?
4. Tenancy first? #326 is closed but `lib/db/schema.ts` has no tenant or secret-store tables, so the
   issue's rule "do not build before #326" is unmet in the code. Do Phase 1 and later wait for real
   tenancy, or may the first release be single-tenant (the owner's own hosts) with the tables made
   tenant-scoped later?
5. Identity pin. Pin the leaf certificate (strict, breaks on renewal), pin issuer and subject (looser),
   or pin only the resolved addresses plus the proof?
6. Request origin. Confirm a BountyDesk relay with a fixed egress IP instead of a sandbox with a DNS
   allowlist, and decide where the relay runs.
7. Writes. Is a per-run, per-recipe opt-in acceptable, or are writes to a live host out of scope for the
   first two releases?
8. Audit retention. How long are live-request audit rows and body excerpts kept, and may they hold a
   third party's data?
9. Domain deny list. Who maintains it, and does it also block claims on hosting-provider domains where a
   file proof cannot show ownership of the underlying account?
10. Gating. Q33 makes live-target mode hosted-only and paid. Confirm, and say whether the first release
    is invite-only.
