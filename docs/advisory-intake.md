# Advisory intake and the advisory delivery channel

A repository with private vulnerability reporting (PVR) turned on lets any GitHub user file a
report as a draft repository security advisory. BountyDesk takes that advisory in as a report on
its own intake channel, `advisory`, and writes the approved verdict back onto the same advisory.
The report never becomes a public issue. The design decision is `docs/decisions.md` Q27, and email
to advisory routing is Q28.

GitHub has no comments API for security advisories. Writing back means editing the advisory: the
approved verdict text replaces the advisory's description. That edit is the only thing BountyDesk
writes on an advisory, and it happens once per approved verdict revision. There is no back-and-forth
thread on the advisory; the reviewer chat is still the only conversation channel, and a later
revision edits the same advisory again.

## The flow

1. A researcher files a private vulnerability report on a repository where PVR is on and the
   BountyDesk App is installed. GitHub creates a draft advisory and sends a `repository_advisory`
   webhook with action `reported`.
2. `POST /api/intake/github` bounds the body, verifies `X-Hub-Signature-256` against the platform's
   App webhook secret, and dispatches `repository_advisory` to `handleAdvisory`
   (`app/api/intake/github/route.ts`). Only `reported` and `published` are taken in. Every other
   action (`edited`, `withdrawn`, and so on) is answered 202 and dropped.
3. In one transaction the route resolves the repository with `activeRepository(installation, repo,
   { lock: true })` and enqueues a job on channel `advisory` keyed by `X-GitHub-Delivery`.
   `activeRepository` returns nothing unless the installation is live and unsuspended, the
   repository is active and not archived, and it has a bound target profile. Anything else is
   answered 202 `repository is not connected` and no job is created. A payload with no `ghsa_id`
   is answered 202 and dropped.
4. The worker's `parseAdvisory` (`lib/jobs/worker.ts`) re-checks the repository, then reads the
   advisory through the API with an installation token rather than trusting the webhook body. That
   read also proves the installation can see the advisory. It creates the report with
   `source_ref = github:<repoId>:advisory:<ghsaId>`, the advisory summary as title and its
   description as body, the connected repository and its target profile bound, and state
   `NEEDS_DECISION`. The job ends at `PARSED -> DONE`. Nothing is cloned, built or probed.
   A `reported` and a later `published` delivery for the same advisory resolve to the same
   `(channel, source_ref)` and so to the same report.
5. The report waits at the gate. Any GitHub user can file a PVR, so there is no allowlist bypass
   and no `/reproduce` command: every advisory waits for a reviewer. "Run analysis"
   (`runAnalysisAction` then `releaseForAnalysis` in `lib/triage/gate.ts`) moves it
   `NEEDS_DECISION -> TRIAGING` and queues the `gate-analysis` job. Dismiss (`dismissAdvisoryAction`)
   moves it to `DENIED` and writes nothing to the advisory.
6. After release the run is the ordinary one. The report already has a bound target, so the agent
   reproduces against it in the offline sandbox. If the repository grant has been revoked by then,
   or the repository is private and the installation lacks Contents: read, the run is
   `ANALYSIS_ONLY`, as for any report.
7. The agent drafts its verdict through `publish_verdict`, and a human approves the exact text.
   `enqueueApprovedVerdictDelivery` (`lib/mcp/publish-verdict.ts`) sends an `advisory` report's
   verdict to the target `github:<repoId>:advisory:<ghsaId>`, which must match the report's own
   `source_ref`. Every outcome is written back: `REPRODUCED`, `NOT_REPRODUCED` and `ANALYSIS_ONLY`.
8. The `advisory` arm (`lib/delivery/advisory-arm.ts`) edits the advisory and the report reaches
   `DELIVERED` in the same transaction as the receipt.

## Email to advisory

An email report whose target is bound to a connected repository can deliver as an advisory
instead of an email reply. At approval, `emailAdvisoryDeliveryTarget` picks the advisory channel
when the report has a grant snapshot, a connected repository, and `hasActiveRepositoryGrant` holds.
The outbox row then carries `channel = advisory` (the `outbound_delivery.channel` override,
migration 0040) and the target `github:<repoId>:advisory:create`; the delivery worker uses the row's
channel over the report's. Otherwise the email report falls back to the email reply to its verified
contact.

The create path opens a draft advisory the first time, with the report title as summary (newlines
flattened, capped at 1024 characters), the approved verdict as description, and a severity and CWE
list derived from the findings. No credits are sent, so the reporter's identity stays in
BountyDesk. A later revision PATCHes the description of that same draft.

The code does not check that the installation has actually accepted the advisories permission when
it chooses this route. An installation that has not accepted it gets a refused and held send (see
below), not a fallback to email. The pinned demo target has no connected repository, so its email
reports always get the email reply.

## The delivery contract

The recipient is the repository grant. At send time the arm re-reads the report's connected
repository and installation and requires `activeRepository` to hold. The target in the leased
outbox row must match: on the reply path it must equal the report's `source_ref`, and on the create
path its repository id must equal the bound repository's.

The receipt is GitHub's answer to the write: a 201 from creating the draft or a 200 from the PATCH,
carrying a `ghsa_id`. That is a transport receipt, so the arm returns `completesReport: true`, the
same as the GitHub issue arm, and the worker records the attempt, marks the row sent and moves
`DELIVERING -> DELIVERED` in one transaction.

Idempotency needs no stored `ghsa_id`. Every write carries the marker
`<!-- bountydesk-delivery:<verdictId> -->`. On the reply path the arm reads the advisory first; a
description that already contains this verdict's marker is a replay, which completes the report
without writing again. On the create path `findAdvisoryByMarker` pages through the repository's
draft advisories. A draft carrying this verdict's marker is a replay, a draft carrying an earlier
revision's marker is PATCHed, and only when neither exists is a new draft created. A PATCH writes
the same approved bytes each time, so repeating it is safe.

The approved-content hash check is the delivery worker's, the same as for every channel: the
payload is read from the immutable verdict and refused if its hash differs from the approved one.

The PATCH sends the description and nothing else. On the reply path that means the reporter's
original description on the advisory is replaced by the approved verdict. BountyDesk keeps the
original in the report body; the advisory no longer shows it.

## Failure states

A revoked grant is refused and held. If `activeRepository` fails at send (installation suspended or
deleted, repository removed or archived, target unbound), the arm returns a refusal with hold.

GitHub refusing the write is held. A 403, 404 or 422 from the advisories API, or a 403 or 404 from
minting the installation token that is not a rate limit, means the installation has not accepted
the advisories permission, cannot see the advisory, or GitHub rejected the edit. Retrying does not
fix any of these.

A held refusal records a `delivery_attempt` with the error and sets the outbox row to `FAILED` with
`requires_human_review`, which takes it out of the claim queue for good. The report stays in
`DELIVERING`, and the case file shows "held for review" with the error. There is no retry action in
the app yet: re-sending a held row after the permission is accepted is an operator step.

A target mismatch or a report with no bound repository is refused without the hold flag.

Anything else, including a rate-limited 403 and network errors, is a transient failure. The row
goes back on exponential backoff up to its attempt limit, and the sweeper fails it once the last
attempt is spent.

## GitHub App prerequisites

- Subscribe the App to the `repository_advisory` webhook event.
- Grant "Repository security advisories: read and write". Read is what `parseAdvisory` needs to
  fetch the advisory; write is what the arm needs to edit or create one. Each installation has to
  accept the change before advisory writes succeed.
- Turn on private vulnerability reporting on each repository that should take reports this way.
  That is a repository setting, done by a repository admin.
- The repository must be connected under a live installation and have a bound target profile, or
  intake answers `repository is not connected` and creates nothing.

The older owner-advisory path is separate and unchanged: for a `REPRODUCED` email or GitHub-issue
report that is already `DELIVERED`, a reviewer can open a private draft advisory for the repository
owner (`lib/delivery/advisory.ts`, `requestOwnerAdvisory`). It keeps its own `owner_advisory` table
and does not use the hold.
