# Upload intake and non-GitHub targets

This is the design record for the work that lets a report be reproduced and delivered without a
GitHub identity. Four pieces make that possible: a `configureTarget` path that binds a target
without a connected GitHub repository, a registry handoff that is not tied to GHCR and does not
leave customer images lying around, an onboarding start command the platform verifies rather than
trusts, and an upload outbound contract that rides the email delivery path.

Two records already own the neighbouring ground and are not repeated here.
[`docs/onboarding-follow-ups.md`](onboarding-follow-ups.md) is the future-work record for the
build, registry and snapshot pipeline. [`docs/target-profiles.md`](target-profiles.md) covers the
target manifest and the dynamic-setup flow. This doc references them where the design leans on
them and covers only what those two do not.

## Invariants every piece here holds

These come from `AGENTS.md` and `docs/decisions.md`, and none of the work below changes them.

- The capability boundary decides which target and which tool authorizations the agent reaches,
  never what it may conclude. Scope, clone, deploy and egress come from the server-held
  `TargetProfile`, not from any agent- or reporter-supplied string.
- No bound target, no `REPRODUCED`. An uploaded or onboarded-but-unbuilt report with no server
  `TargetProfile` stops at `ANALYSIS_ONLY`, and a human decides.
- The human approval gate is never skippable. `publish_verdict` freezes the delivery target and
  the `approved_content_hash` at approval, and the delivery worker refuses any payload whose hash
  differs from the approved one.
- No channel records a `DeliveryAttempt` or reaches `DELIVERED` without a verified recipient and a
  transport receipt.

## The non-GitHub configureTarget seam

### Current state

`configureTarget` in `lib/targets/configure.ts` throws
`GitHub repository <id> is not an active connected repository` unless a `connected_repository`
row under a live installation exists. The GitHub App install webhook creates that row. A
hand-driven onboarding, or an email or upload target with no GitHub identity, has none, so it
cannot get a profile. This is the gap `docs/onboarding-follow-ups.md` names under
"configureTarget requires an active connected repository": a non-GitHub target cannot be written
today, which means a non-GitHub report cannot be reproduced at all.

### Design

Give `configureTarget` a second path that binds a target to a target id without a GitHub
`connected_repository`, while keeping the connected-repo check for GitHub-sourced targets. The
inputs the check guards, the image digest, snapshot id and build marker, all come from the same
server-held sources whichever path writes the profile, so the trust model does not change; only
the identity that the profile hangs off does. This seam is shared groundwork: both a non-GitHub
onboarded target and a reproducible uploaded report need it, so it is built once rather than per
channel.

### What this does not relax

The profile still carries a verified image digest, snapshot id and build marker, and a dynamic
write still refuses to go without a `build_recipe_digest`. Reproduction still runs in the
no-egress sandbox, and the agent still reaches the app only through `probe_target` and
`probe_target_write`. Removing the GitHub identity requirement does not remove any of the identity
proofs that make a snapshot trustworthy.

## Pluggable and ephemeral registry handoff

### Current state

A registry cannot be removed from the design, and `docs/onboarding-follow-ups.md` explains why:
Daytona's non-registry snapshot paths run its own builder with open egress, which the
untrusted-build model forbids, and there is no path that imports a prebuilt image tarball. So the
image built inside the egress-controlled build sandbox has to travel through a registry to reach
the offline reproduction snapshot. The open question is which registry and how private, not
whether.

The coupling to GHCR is thin and lives in a few places. `lib/build-onboarding/daytona-build-driver.ts`
holds the `docker login/push/logout ghcr.io -u bountydesk` host and reads `GHCR_NAMESPACE` and
`GHCR_PUSH_TOKEN`. `lib/targets/manifest.ts` hardcodes the registry host in its image-name check:
`IMAGE_NAME_RE = /^ghcr\.io\/.../`. Everything downstream is already registry-agnostic:
`createSnapshot` in `lib/sandbox/daytona.ts` takes any `registry/name` tag, and a reproduction
pull has been proven against both GHCR and a plain Docker Hub image. The build marker that
re-verifies identity is baked into the image layers and read from inside the booted snapshot
(`lib/sandbox/build-marker.ts`), so it survives whatever registry the image passes through, and
the image digest folded into `build_recipe_digest` is a content hash, registry-independent by
construction.

### Design: parameterize the registry

The seam parameterizes which registry, not whether there is one. A thin registry handoff replaces
the GHCR literals at the push site. It resolves the untagged repo ref for a build, logs in inside
the build sandbox right before the push and hands back a teardown that logs out right after, and
names the host to add to the build egress allowlist so a non-GHCR registry is reachable. The
return contract is unchanged: the driver still yields a pullable tag ref and a `sha256:` digest
read from the pushed image's `RepoDigests`. Nothing downstream changes, because the seam only
removes the `ghcr.io` assumption from the push, not the shape of what push produces.

Credentials thread exactly as they do now. The push token is server-held env, introduced only at
login time inside the build sandbox and removed by the returned teardown, so the untrusted build
still never runs with a reusable token. The login step owns the provider-specific auth, whether
that is `docker login <host>`, an ECR password exchange, or a GAR key.

New env replaces the GHCR-specific names: a registry host, user, namespace and push token, with
today's GHCR values kept as the defaults so nothing breaks. Per-medium and per-tenant routing
falls out of setting different values with no code branch: GitHub targets can keep GHCR, email or
upload targets can point at a neutral registry, and each tenant can get its own namespace. The
GHCR leak in `manifest.ts` is fixed at the same time by generalizing `IMAGE_NAME_RE` to the
configured registry host while keeping the untagged and undigested rule.

This is one interface with one implementation today, which the codebase normally treats as an
abstraction to avoid. It earns its place because its purpose is to delete the GHCR coupling and
its return type is unchanged, so it is a rename with a seam, not a speculative factory. Do not add
ECR or GAR implementations until a second registry is actually wired.

### Design: make images ephemeral

The snapshot is the durable artifact. The pushed registry image only needs to exist for the
seconds of the handoff, so delete it once the snapshot is registered and active. This is the
largest privacy win for the least code, and it works with any registry, because delete-by-digest
is a standard registry API. It makes the customer's code present in the registry for seconds
rather than indefinitely.

Snapshots are not deleted the same way, because a `TargetProfile` boots from its snapshot on every
reproduction run. The design distinguishes two kinds. Trial snapshots from agent iteration that no
approved profile references are eligible for a time-based sweep, gated on a reference check against
`target_profile.snapshotId` so nothing an approved target uses is ever swept. Pinned snapshots
that an approved `TargetProfile` points at, such as the frozen Juice Shop demo, are never swept.
The existing name-reuse handling in `deleteSnapshotByName`, which lists then deletes by id
idempotently, is the shape to reuse for both the trial sweep and the superseded-image delete.

One question gates the delete timing and is called out below: whether Daytona pulls the image
eagerly at `createSnapshot` or lazily at first sandbox boot. If the pull is lazy, the image has to
survive until first successful reproduction boot, not just until registration returns.

## The onboarding start command model

### Current state

The reproduction sandbox is the target container itself, booted offline from the snapshot with no
Docker daemon inside. A `docker run` start command can never work there, which the first live run
hit as `docker: not found`, recorded in `docs/onboarding-follow-ups.md` under "host-model start
command". Validation already rejects host-model commands in three places: `validateStartCommand`
in `lib/targets/manifest.ts`, `assertSafeMeshStartCommand` in `lib/sandbox/provision.ts`, and the
agent's `commit_compose_mesh` build tool, which refuses `command` and `entrypoint` fields so a
built service sets its start command through the CMD of the Dockerfile it writes.

### Design

The agent proposes a start command, readiness path and port alongside the built image through its
`commit_target_image` build tool, but the proposal is verified in the build sandbox before it is
ever stored, not trusted from prose. The onboarding worker already boots the snapshot to check
readiness and confirm no egress. That verify step extends to run the proposed start command in the
offline booted snapshot and confirm the app answers its readiness path. A command that only works
with network, or that needs a Docker daemon, fails the verify and is rejected with a concrete
reason back to the agent. Whether the app actually starts this way becomes a machine check rather
than a review judgement.

The validation gates on the proposed command reuse the existing rules rather than inventing new
ones: non-empty, single line, within the length cap, head not one of the container host commands
and not smuggled in after a shell separator. The command runs only inside the offline reproduction
container, which has no secrets and no egress, so there is no injection surface beyond what the
existing validators already cover.

The reviewer still approves the exact command. The proposed start command and readiness path land
on the onboarding row's build plan and are surfaced on the approval sheet through
`reviewableManifest`, which already hoists the start command to a flat field so a reviewer sees it.
Only after approval does `configureTarget` write the `TargetProfile`. The flow is: agent proposes,
build sandbox verifies by booting offline and checking readiness, reviewer approves the exact
command, profile is written. The repo stays a passive test app and no repo-local script is
authoritative for reproduction, which `docs/target-profiles.md` states as the rule. Recording the
offline-verify result on the onboarding row lets the reviewer see "verified to boot offline"
rather than approving an unverified command; no new manifest fields are needed beyond that.

## The upload outbound contract

### Current state

Upload intake is designed, not built. The upload entry in `app/(app)/integrations/catalog.ts`
carries `built: false` with the reason that it has the same outbound gap as email once had: no
verified recipient and no transport receipt, so no delivery. There is no upload intake route and
no upload page; `app/api/intake/` holds only `email`, `github` and `jobs`.

The email path already satisfies the two-part contract and is the pattern to reuse. The verified
recipient is a single gate, `isVerifiedEmailRecipient` in `lib/email/recipient.ts`: a contact
qualifies when it equals the report's `verifiedSender`, the address that passed inbound SPF and
DKIM at intake, or when it is an allowlisted reviewer address. The target is frozen at approval:
`publish_verdict` decides the delivery target per channel, enqueues the outbox row with that target
and the approved content hash, then moves the report to `DELIVERING`. Send and receipt are split:
`emailArm` in `lib/delivery/email.ts` re-checks the recipient and the leased target at send time,
sends through Resend, stamps the provider message id and returns SENT with a null `delivered_at`,
leaving the report in `DELIVERING`. Only the Resend `email.delivered` webhook, applied in
`lib/email/receipts.ts`, moves `DELIVERING` to `DELIVERED`, and it correlates purely on the
provider message id, so it is channel-agnostic. The `intakeChannel` enum in `lib/db/schema.ts` is
`github, email, manual`, with no `upload`, and the delivery worker's arm map covers only github and
email.

### Design

The delivery half is already channel-agnostic, so the only real gap for upload is the recipient:
an upload has no inherent reply-to address, and OTP proof today exists only for the reviewer
allowlist, not for an arbitrary reporter.

The uploader supplies an email contact and proves control of it by a one-time code, mirroring the
reviewer OTP pattern but bound to the report rather than the allowlist. An uploader is not a
reviewer and must not become one. The cheapest storage that keeps the security gate untouched is
to set the report's `verifiedSender` to the OTP-verified contact, so `isVerifiedEmailRecipient`
passes with no change: it already means "delivery accepts this contact while it equals the proven
value, re-checked at send". OTP proves the same "this exact address is controlled" that SPF and
DKIM prove for inbound email; the proof method differs, so it is recorded in an audit event or a
small verification-method field for honesty, but the gate logic and the send and receipt paths do
not change. The OTP flow itself generalizes the reviewer helpers (`hashCode`, the code TTL and the
attempt cap in `lib/auth/reviewers.ts`, and `sendVerificationEmail`) into a report-scoped
verification. A report can still be created and triaged before the contact is verified, because
intake and reproduction are separate; verification only has to complete before the report can be
approved for delivery.

The transport is the email path, exactly as `AGENTS.md` hints. An upload with a verified email
contact rides the proven Resend send and `email.delivered` receipt, which makes its SENT and
DELIVERED semantics identical to email by construction. An in-app inbox with its own pickup receipt
would be a second delivery channel with its own auth, notification and audit surface, re-solving a
problem email already solves, so it is out of scope unless a concrete requirement forbids emailing
the verdict.

The wiring to ride email is small. Add `upload` to the `intakeChannel` enum through a migration for
honest provenance, so the board and case file show a report arrived by upload rather than
masquerading as email. Add an `upload` branch to the delivery-target switch in `publish_verdict`
that mirrors the email branch, requiring a verified `reporterContact` and accepting the upload
source-ref form. Map `upload` to the existing email arm in the delivery worker, and widen the
delivery-context channel union to include `upload`. Nothing in `receipts.ts` changes, because the
delivered webhook already completes any delivery it can correlate by provider message id.

### What stays unchanged

The approval gate on exact text is untouched: the content hash is frozen at `publish_verdict` and
re-checked in the delivery worker before send. The intake-versus-reproduction separation holds: an
uploaded report with no bound `TargetProfile` stops at `ANALYSIS_ONLY`, and upload delivery only
ever carries an approved verdict, which may be `ANALYSIS_ONLY`. Reproducing an uploaded report
needs the non-GitHub `configureTarget` path above first; delivering an analysis-only verdict does
not. An uploaded body or attachment is untrusted input and is parsed the way email intake already
parses untrusted input, and the verdict email renderer already escapes agent- and target-echoed
markup, which upload payloads inherit.

## Open questions

- Does Daytona already hold a GHCR pull credential, or is the onboarding image public? A private
  neutral registry needs its pull credential registered in Daytona per host, which is a
  control-plane config item, not code in this repo. The seam should document it and fail loud if a
  snapshot never leaves the pulling or error state for a private ref.
- Can a registry image be deleted by digest immediately after `createSnapshot` returns, or does
  Daytona pull lazily on first sandbox create? If the pull is lazy, ephemeral deletion has to
  happen after the first successful reproduction boot, not after registration.
- Do trial snapshots accumulate today, or does the agent iterate only in a build sandbox so the
  final `onboarding-<slug>` snapshot is the only one created? Verify before building a sweeper.
- Does making upload a real intake channel ripple into read models, board filters or dedupe? The
  channel is part of the unique `(channel, source_ref)` index, so a new enum value is cleaner than
  overloading email, but the read side needs a check.

## Phased path

The upload outbound contract is the first shippable feature, because its delivery half is already
channel-agnostic and the only real work is a report-scoped OTP plus an enum value and two small
branches. The non-GitHub `configureTarget` path is shared groundwork that both the upload channel
and any non-GitHub target need, so it is built once and early. The registry work is the onboarding
hardening the multi-service mesh and the pentest workbench lean on.

1. Delete the pushed image after the snapshot is registered. Smallest diff, biggest privacy win,
   no interface change, gated on the lazy-pull open question above.
2. Contact OTP verification for uploads and the delivery wiring: the report-scoped OTP that sets
   `verifiedSender`, the `upload` enum value, the `publish_verdict` branch, the arm map entry, and
   the widened channel union. After this, an approved upload verdict rides email to SENT then
   DELIVERED.
3. The non-GitHub `configureTarget` path, which unblocks reproducible non-GitHub targets and any
   uploaded report that should be reproduced rather than left at `ANALYSIS_ONLY`.
4. Parameterize the registry: introduce the registry handoff, replace the GHCR literals and the
   `manifest.ts` regex, and default the env to today's GHCR values.
5. Offline start-command verify: extend the onboarding verify step to boot the proposed start
   command offline, check readiness, reject on failure, and record the result for the reviewer.
6. The upload intake route and minimal UI, which creates the report as `ANALYSIS_ONLY` by default
   and collects and verifies the contact, then flips the catalog entry to `built: true`.
7. Attachment and size hardening, and the trial-snapshot sweeper if trial snapshots turn out to
   accumulate.
