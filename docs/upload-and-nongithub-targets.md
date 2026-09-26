# Upload intake and non-GitHub targets

This is the record for the work that lets a report be reproduced and delivered without a GitHub
identity. It started as a design record (#264) and now describes what was built, in #266, #267,
#281, #283 and #285, with each deviation from the design called out where it happened. The
decisions are `docs/decisions.md` Q30 (non-GitHub sources) and Q32 (upload intake).

Four pieces make it work: a path that binds a target without a connected GitHub repository, a
registry handoff that is not tied to GHCR and does not leave customer images behind, an onboarding
start command the platform boots before it stores, and an upload channel whose verdict rides the
email delivery path.

Two records own the neighbouring ground and are not repeated here.
[`docs/onboarding-follow-ups.md`](onboarding-follow-ups.md) is the future-work record for the build,
registry and snapshot pipeline, and lists what is still open. [`docs/target-profiles.md`](target-profiles.md)
covers the target manifest and the dynamic-setup flow.

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

## Binding a target without a connected repository

`configureTarget` in `lib/targets/configure.ts` still requires a `connected_repository` row under a
live installation, and keeps doing so for GitHub-sourced targets. A target with no GitHub identity
binds through `configureConnectionlessTarget` in the same file. It writes the profile with no
connected repository, and it requires the same proofs: an image digest, a snapshot id, a build
marker, an identity anchor and a `build_recipe_digest`. Its caller is
`bindConnectionlessTargetFromBuild` (`lib/build-onboarding/connectionless-bind.ts`), which turns a
finished build into a profile; the upload build loop is the one production caller.

The identity anchor is any one of a commit SHA, a source archive digest, or the image's own digest
(`hasIdentityAnchor` in `lib/build-onboarding/source-identity.ts`). The design did not name this;
it was needed because an uploaded tarball or prebuilt image has no commit.

The build driver stages three source kinds (`lib/build-onboarding/build-driver.ts`,
`stageSource` in `daytona-build-driver.ts`):

- `git`: clone, check out the exact SHA, confirm HEAD. Only the server-derived github.com URL of the
  same repository ever gets a token.
- `archive`: the controller hashes the bytes, the sandbox re-hashes them before `tar -xf`, and the
  archive digest is the build marker.
- `image`: nothing is staged. The driver writes a Dockerfile of `FROM <name>@<digest>` and bakes
  the digest into `/etc/bountydesk-build-marker`, so the booted snapshot carries a marker the
  platform checks. The image's registry must be on `PREBUILT_IMAGE_REGISTRIES` (default
  `docker.io,ghcr.io`), because it joins the build egress allowlist.

What this does not relax: reproduction still runs in the no-egress sandbox, and the agent still
reaches the app only through `probe_target` and `probe_target_write`.

Not built: rotating a connectionless profile (a changed re-bind throws `TargetProfileExistsError`),
a tarball without a Dockerfile at its root, and a non-GitHub git URL. They are listed in
`docs/onboarding-follow-ups.md`.

## Pluggable and ephemeral registry handoff

A registry cannot be removed from the design. Daytona's non-registry snapshot paths run its own
builder with open egress, which the untrusted-build model forbids, and there is no path that
imports an image tarball. So the image built in the egress-controlled build sandbox travels through
a registry to reach the offline reproduction snapshot.

As built, `RegistryHandoff` (`lib/build-onboarding/registry.ts`) owns the push, the digest read and
the delete, and returns `{ pullableTag, digest }` as the design specified. The env is
`REGISTRY_HOST`, `REGISTRY_USER`, `REGISTRY_NAMESPACE` and `REGISTRY_PUSH_TOKEN`, defaulting to
`ghcr.io`, `bountydesk`, and the old `GHCR_NAMESPACE` and `GHCR_PUSH_TOKEN`, so an existing
deployment needs no change. `IMAGE_NAME_RE` in `lib/targets/manifest.ts` accepts any registry host
and still refuses a tagged or digest-pinned name. There is one implementation, as the design asked;
no ECR or GAR variant was added.

Images are ephemeral where the registry allows it. The open question the design raised is settled:
Daytona pulls a snapshot's image eagerly at registration (verified 2026-09-26), so the driver
deletes the pushed image once the snapshot is active. That needs `REGISTRY_DELETE_TOKEN`, a token
with `delete:packages`. The design expected a registry-agnostic delete by digest; what was built
deletes a GHCR package version by tag through the GitHub Packages API. On any other registry, or
without the token, the image is left in place with a warning, which is harmless because the
snapshot is self-contained. The mesh path does not reclaim its images yet.

Snapshots are handled as designed. `sweepTrialSnapshots` (`lib/sandbox/daytona.ts`) deletes
`onboarding-` snapshots that no target profile, mesh service or in-flight onboarding row
references. Nothing schedules it yet.

## The onboarding start command

The reproduction sandbox is the target container, booted offline with no Docker daemon, so a
`docker run` start command can never work. `validateStartCommand` and `assertSafeMeshStartCommand`
reject host-model commands, and the agent's `commit_compose_mesh` tool refuses `command` and
`entrypoint`.

As built, the proposed start command reaches the reviewer through `reviewableManifest`, and the
boot check runs after approval: `verifyAndWrite` in `lib/build-onboarding/worker.ts` re-validates
the command, boots the snapshot offline with it and waits for readiness, and writes the
`TargetProfile` only if that succeeds. A command that does not boot leaves the row approved and
unwritten. This differs from the design in one respect: the boot happens after the reviewer
approves, not before, so the reviewer does not see a "verified to boot offline" result; a command
that fails simply never becomes a profile.

## Upload intake

The design put the upload UI under `app/(app)/` and had the route create the report at
`ANALYSIS_ONLY`. As built, the public page is `/submit` (`app/submit`), outside `app/(app)`,
because an uploader is not a reviewer and needs no account, and the report lands at
`NEEDS_DECISION`, the same gate an outside email waits at.

`/submit` posts a multipart form to `app/api/intake/upload/route.ts`. The route checks the content
type and caps the request at 4 MB before parsing, then `lib/upload/intake.ts` bounds each field and
the attached material and applies the outside-email daily limits per contact and per domain, plus
10 uploads a day per client address. There is no captcha. An accepted upload becomes an `upload`
report with `source_ref = upload:<uuid>` and an `upload_intake` row beside it (migration 0043), and
the contact is mailed a report-scoped code. `app/api/intake/upload/verify/route.ts` confirms the
code or sends another, acting only on upload reports and only on the address given at upload. At
most three codes go out per report, the first included.

The body is parsed in the route process with bounds, not in the sandbox the design described for
email attachments. An uploaded archive is only unpacked inside the build sandbox.

Target material is optional and at most one of: a tarball with a Dockerfile at its root, a single
Dockerfile of at most 64 KB with a `FROM` line (stored as a deterministic one-file tarball so it
takes the archive path), or a prebuilt image named by tag and sha256 digest. A prebuilt image's
registry is checked against `PREBUILT_IMAGE_REGISTRIES` at intake and again in the build driver.
There is no git URL option.

Nothing builds until a reviewer releases the report at the gate with "Build target and run" and
states the port, readiness path, optional start command and build ecosystem
(`app/(app)/reports/[id]/upload-gate.tsx`, `approveUploadTarget` in `lib/upload/gate.ts`). Those
are validated through `targetDefinitionFromManifest` into a definition whose name and repository
label come from the report id and whose scope is loopback only. The report moves to `TRIAGING`. The
`upload-build` worker loop (`lib/upload/build.ts`) builds the material, pins it with
`bindConnectionlessTargetFromBuild`, binds the report, and queues the same analysis run the gate's
"Run analysis" queues. A build gets two attempts. One that fails twice, or is skipped because a
reviewer bound another target meanwhile, leaves the report as it was, and the run proceeds without
the uploaded target, ending `ANALYSIS_ONLY` if nothing is bound. A failed upload build does not get
the static review a failed GitHub build gets.

The gate also offers "Run analysis" without building, and "Dismiss", which moves the report to
`DENIED`.

## Upload delivery

Upload rides the email transport, as designed. The uploader's confirmed contact is written to the
report's `verified_sender` (`lib/auth/report-contact.ts`, on the shared OTP primitives in
`lib/auth/otp.ts`), so `isVerifiedEmailRecipient` accepts it with no change. Starting a new
verification clears `verified_sender`. The proof method is recorded as the event
`upload.contact_verified` with `method: "otp"`; there is no column for it.

`publish_verdict` has an `upload` branch that requires a confirmed contact and an `upload:` source
ref, the delivery worker maps `upload` to the email arm, and the arm re-checks the recipient at
send. `DELIVERED` needs Resend's `email.delivered` webhook, the same as email. An unconfirmed
contact is refused at approval and again at send, so the report cannot be delivered, though a
reviewer can still work it. Nothing expires an unconfirmed upload report.

The read side shows the channel as upload (`lib/reports/channel-copy.ts`), which answers the
design's question about board filters and read models.

## Still open

- Whether Daytona needs a pull credential per private registry host. That is control-plane
  configuration, not code in this repo; `docs/deployment.md` records the GHCR one.
- Everything under "Still open" in `docs/onboarding-follow-ups.md`.
