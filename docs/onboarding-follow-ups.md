# Target onboarding follow-ups

The manifest-driven onboarding pipeline (`lib/build-onboarding`) builds a connected repository
into a Daytona snapshot, has an onboarding agent propose a target manifest, and after a reviewer
approves it writes the `TargetProfile`. The first live run of the whole chain, against
`crccheck/docker-hello-world`, proved the build, GHCR push, snapshot, manifest proposal and
approval all work, and surfaced the items below. This is the future-work record for the pipeline:
each section says what is built and what is still open.

Still open, in one place:

- Recipes for a tarball without a Dockerfile beyond node and python (see below).
- A non-GitHub git URL without a root Dockerfile, a private one, and a live GitLab clone in Daytona (see below).
- Sweeping mesh images orphaned by a crashed build, and deleting images on Docker Hub.
- A self-hosted private registry at multi-tenant scale.

## Source identity is resolved before customer code runs

The driver used to clone the repository's default HEAD and bake whatever that resolved to as the
build marker, so a build could not prove which commit it built. That is closed: the trusted worker
resolves a full commit SHA for the onboarding row before classification reads any source, and the
build driver checks out that exact SHA and asserts `git rev-parse HEAD` matches before running the
customer's build. The agent's own iteration sandbox checks out the same SHA.

The resolved commit and an optional source-archive digest are stored on the onboarding row, and the
resulting identity (repository, commit, archive digest, plan, every service image digest and
snapshot) is folded into a `build_recipe_digest` that a dynamic `TargetProfile` write refuses to go
without.

The identity anchor is now any one of a commit SHA, a source archive digest, or the built image's own
digest, so a source with no git commit (an uploaded tarball, a prebuilt image) can still be anchored.
`hasIdentityAnchor` (`lib/build-onboarding/source-identity.ts`) is the single check, applied at
`sourceIdentityDigest`, the build driver's pre-build gate, the onboarding write in `verifyAndWrite`,
and `configureConnectionlessTarget`. A present-but-mutable commit ref like `HEAD` is still refused
rather than hashed into a stable-looking identity. The git-clone driver still needs a commit to check
out. Non-git sources are staged by their own paths in the build driver: an archive is re-hashed in the
sandbox and unpacked, and a prebuilt image is wrapped in `FROM <name>@<digest>` with the digest baked
into the build marker (`docs/decisions.md` Q30).

## Make the registry handoff pluggable, not GHCR-specific

A registry cannot be removed from the design. Daytona turns one of three things into a snapshot:
an image it pulls from a registry, a Dockerfile it builds itself, or a declarative SDK build. The
two build modes run Daytona's own builder with open egress, which the untrusted-build model rules
out, and there is no path that imports a prebuilt image tarball. So the image built inside the
egress-controlled DinD sandbox has to travel through a registry to reach the offline reproduction
snapshot. The question is which registry and how private, not whether.

The coupling to GHCR is now behind one interface. `RegistryHandoff` (`lib/build-onboarding/registry.ts`)
owns the push, the digest read, and the image delete; the build driver holds no registry host or
login. The default is GHCR, configured through `REGISTRY_HOST`, `REGISTRY_USER`, `REGISTRY_NAMESPACE`
and `REGISTRY_PUSH_TOKEN` with the historical `GHCR_NAMESPACE` and `GHCR_PUSH_TOKEN` as the fallbacks,
so an existing deployment needs no new configuration. Any OCI registry plugs in by setting those, and
a later ephemeral or private registry replaces the whole thing by implementing the interface.
Everything downstream was already registry-agnostic: `createSnapshot` takes any `registry/name` tag,
and a reproduction pull has been proven against both GHCR and a plain Docker Hub image.

`IMAGE_NAME_RE` in `lib/targets/manifest.ts` accepts any registry host, not just `ghcr.io`; a tagged
or digest-pinned name is still refused, so a stored `imageName` stays an untagged reference.

The pushed image is reclaimed after its snapshot materialises. Daytona pulls a snapshot's image
eagerly at registration, verified 2026-09-26: a `POST /snapshots` goes pending, pulling, active in
about ten seconds with no sandbox create, and a sandbox then boots from the materialised snapshot. So
once the snapshot is active the origin registry tag is dead weight, and the driver deletes it,
best-effort, after `waitForSnapshotActive`. GHCR deletion needs a delete-scoped token: set
`REGISTRY_DELETE_TOKEN` (a token with `delete:packages`) to reclaim the image, otherwise it is left
in place, which is harmless because the snapshot is self-contained. GHCR uses the GitHub Packages
API. Any other registry host uses the Docker Registry HTTP API v2: a HEAD on the tag reads
`Docker-Content-Digest`, then a DELETE by digest, with Basic auth from `REGISTRY_USER` and
`REGISTRY_DELETE_TOKEN`. A 404 means the image is already gone, and a 405 (the registry has deletes
disabled) leaves it in place with a warning. Docker Hub and other registries that do not expose the
v2 delete are not covered. The mesh path reclaims each service image right after that service's own
snapshot is active, through the same `reclaimOriginImage`, so a failure never fails the build. Only
the deletion paths were tested with mocked fetch; neither a real mesh build against GHCR nor a v2
registry has been run.

`sweepTrialSnapshots` (`lib/sandbox/daytona.ts`) reclaims build-created snapshots that no live target
depends on: it deletes `onboarding-` snapshots whose id is not in the protected set, where the set is
every snapshot a target profile pins (single-image and each mesh service) plus every in-flight
onboarding row's built snapshot (`collectProtectedSnapshotIds` in `worker.ts`). The worker daemon
runs it through `sweepOrphanSnapshots` as the `snapshot-sweep` maintenance slot in
`scripts/run-worker-daemon.ts`, at most once every six hours, and logs only when it deletes
something. A build registers its snapshot before the database records the id (an onboarding when it
leaves `PENDING_BUILD`, an upload build when it binds the profile), so a pass that finds an onboarding
row in `PENDING_BUILD` or an upload row in `PENDING` or `BUILDING` deletes nothing and waits for the
next interval.

Remaining work:

- Sweep images orphaned by a build that crashed after pushing but before reclaiming. The pushed
  tags are random per build (`bountydesk-<hex>`) and nothing records them, so a sweep needs either
  a table of pushed refs or a registry listing; skipped as a schema change.
- Live-verify mesh reclaim against GHCR and v2 delete against a real registry.
- At multi-tenant scale, self-host a private registry. Zot is a single static binary over
  filesystem or S3 storage and is the lightweight option; Harbor adds per-project RBAC, which is
  per-tenant isolation, plus scanning and retention. This is the proper fix for customer images
  commingled in one namespace, and it belongs to the multi-tenancy workstream, not the build
  model.

Sources: Daytona snapshots (https://www.daytona.io/docs/en/snapshots/) and declarative builder
(https://www.daytona.io/docs/en/declarative-builder/); container registry comparison
(https://distr.sh/blog/container-image-registry-comparison/); Harbor vs Distribution vs Zot
(https://www.pistack.xyz/posts/2026-05-23-self-hosted-container-registry-management-harbor-distribution-zot/).

## The onboarding agent proposes a host-model start command

In the live run the `bountydesk-target-onboarding` agent proposed
`startCommand: docker run --rm -p 8000:8000 ghcr.io/...`. The reproduction sandbox is the target
image itself, booted offline from the snapshot with no Docker daemon inside, so app start fails
with `docker: not found`. The start command has to be the in-container command that launches the
app (the busybox target's `httpd`, a node start, and so on), never a `docker run` of the image.

The parser, onboarding worker, reproduction authorization, and mesh provisioner now reject
host-model commands. Keep the agent instruction aligned with that contract, and retain regression
tests for `docker`, `docker-compose`, `podman`, and `nerdctl` commands, including shell wrappers.

The proposed start command is verified before the profile is stored, not just parsed. `verifyAndWrite`
re-runs `validateStartCommand` on the single-image start command at the write seam (defence in depth
against a stored manifest changed between proposal and approval; mesh services validate per service in
`assertSafeMeshStartCommand`), and the offline provision then actually launches the command and waits
for readiness. A command that does not boot fails the verify, so the row stays approved and unwritten
rather than binding a target that never starts. The reviewer sees the command in `reviewableManifest`
before approving.

## Compose mesh start commands and service names

A compose-mesh service starts with what Compose would run: the classifier reads the service's
`command` and `entrypoint` from the repository's compose file into the build plan as exec argv, and
the build driver combines them with the image's own ENTRYPOINT, CMD and WORKDIR into the stored start
command (`meshStartCommand` in `daytona-build-driver.ts`). Compose's rules apply: `command` replaces
CMD, `entrypoint` replaces ENTRYPOINT and also drops the image's CMD unless `command` is set, and
`[]` or `''` is an explicit empty override. A string command is split into words the way Compose
does (go-shellwords), not run through a shell, and each word is quoted into the start command so the
provisioner's `sh -c` hands `sh -c "<script>"` its script whole. The agent's `commit_compose_mesh`
tool refuses these fields; an agent-authored service sets its start command through the CMD of the
Dockerfile it writes.

NodeGoat was the case that needed this. Its web command waits for mongo, seeds the database, then
runs `npm start`; without it the image's bare `node` CMD started and nothing listened on port 4000.

A service reaches a peer by its compose service name. The provisioner writes `<link ip> <name>` into
the service's `/etc/hosts`, looking the ip up by the peer's sandbox id on the link network, for every
name in the service's `peers`. The classifier fills `peers` from `depends_on` and from any service
named as a host in the service's environment, command or entrypoint (`mongodb://mongo:27017/db`,
`nc -z mongo 27017`), so nothing in the image has to be rewritten. Compose itself resolves every
service on its default network; the mesh maps only the names a service refers to, since each entry
is a lookup that must succeed for the mesh to boot.

Known limits:

- A string command with shell syntax outside `sh -c` (`a && b`, a redirect) is refused rather than
  truncated the way go-shellwords would, and so is a multi-line command or one over 1000 characters.
- compose-synth ignores `command`: the flattened image boots from its own entrypoint.
- A service name used only inside a config file the classifier does not read (not env, command or
  entrypoint) gets no hosts entry unless `depends_on` names it.
- Dependency-to-dependency lookups (two linked children) have not been exercised live; the proven
  path is the app (link parent) reaching a dependency (link child).

## Binding a target without a connected repository

`configureTarget` (`lib/targets/configure.ts`) still requires a `connected_repository` row under a
live installation, and that is right for GitHub-sourced targets. A target with no GitHub identity
binds through `configureConnectionlessTarget` instead, which writes a profile with no connected
repository and the same digest, snapshot and build-marker proofs, and requires an identity anchor and
a `build_recipe_digest`. Its caller is `bindConnectionlessTargetFromBuild`
(`lib/build-onboarding/connectionless-bind.ts`), which the upload build loop uses. A re-bind with changed pins rotates through
`rotateConnectionlessTarget`, which keeps the row id, but only when the caller proves it holds the
current claim (the upload build passes its lease check); otherwise the drift error stands.

Remaining work:

- A tarball without a Dockerfile builds from a thin recipe the server authors (`lib/upload/recipe.ts`),
  not from the onboarding agent: that agent's tools resolve a `target_onboarding` row and clone from
  GitHub, and an upload has neither. The recipe is a generic-base Dockerfile for node or python, from
  the reviewer's ecosystem or the manifest files in the archive, with the reviewer's port and start
  command. It runs as the existing `agent-authored` plan, pinned on the archive digest. Any other
  ecosystem, or python without a start command, authors nothing: the build is skipped and the report
  gets the static review of its archive (`COULD_NOT_BUILD`). Still open: more ecosystems, and letting
  the onboarding agent author the recipe for archives the templates do not cover. Not yet run live
  against Daytona.
- A public non-GitHub git URL (GitLab, Bitbucket, self-hosted) is accepted at intake as a `git`
  material kind: an https URL plus a full 40-character commit SHA (`lib/upload/git-source.ts`). A
  branch, tag or `HEAD` is refused, so the server makes no network call to resolve a ref. The build
  clones anonymously, checks out the SHA and compares `git rev-parse HEAD` with it, the same driver
  path a GitHub source takes, and only that one clone host joins the build egress allow-list
  (`cloneHostOf` in `daytona-build-driver.ts`). The result binds as a connectionless target pinned on
  the commit. Still open: a git source with no root Dockerfile is not built, because the thin recipe
  needs the file tree on the server and the clone happens inside the sandbox, so it ends in the static
  review with no source to read; credentials for a private non-GitHub host; and a live GitLab clone in
  Daytona, which has not been run.

## The build egress allowlist is per-ecosystem

The build driver now selects a bounded per-ecosystem egress allowlist from
`lib/build-onboarding/egress-profiles.ts` and adds only plan-declared extra hosts. The reproduction
sandbox remains offline. New ecosystems or package hosts need an explicit profile and test update; do
not restore a global allowlist that widens every build.

On a restricted Daytona tier (1 or 2) that allowlist is refused: `createBuildSandbox` falls back to
the org egress policy after proving the sandbox still cannot reach the open internet
(`assertOrganizationEgressRestricted`). The org policy reaches the common package hosts (GitHub, npm,
PyPI, Debian mirrors) but not the Alpine apk mirror, so a Dockerfile built on an Alpine base with
`apk` steps fails to build and the report degrades cleanly to a static review (`COULD_NOT_BUILD` then
`ANALYSIS_ONLY`). Debian-family bases (`*-slim`, `debian`, `ubuntu`, `node`, `python`) build fine,
which is why the demo and test targets use them. This is a reachability limit of the tier, not a
code gap: the per-sandbox allowlist is already correct and starts working on Tier 3 or 4, where a
per-sandbox list replaces the default. Deciding to reproduce Alpine-based targets is a billing-tier
choice, not a code change. Prefer a Debian base when authoring or uploading a Dockerfile.

## Resolved

The no-egress oracle now accepts `wget` as well as `curl` (see `classifyEgressProbe` in
`lib/sandbox/provision.ts`), so a target built on a minimal base such as busybox or alpine clears
`verifyNoEgress`. The readiness probe (`waitForAppReady`) accepts `wget` the same way. This removed
the first blockers the live run hit.

The onboarding queue schedules on database time. `advance`, `enqueue` and approval set
`next_attempt_at` to the database's `now()`, the same clock `claim()` compares against, so a worker
whose clock runs ahead of Postgres no longer parks the next step in the future. That skew was why
the worker tests left rows at `PENDING_MANIFEST` on developer machines.
