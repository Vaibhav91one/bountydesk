# Target onboarding follow-ups

The manifest-driven onboarding pipeline (`lib/build-onboarding`) builds a connected repository
into a Daytona snapshot, has an onboarding agent propose a target manifest, and after a reviewer
approves it writes the `TargetProfile`. The first live run of the whole chain, against
`crccheck/docker-hello-world`, proved the build, GHCR push, snapshot, manifest proposal and
approval all work, and surfaced the items below. This is the future-work record for the pipeline.

## Source identity is resolved before customer code runs

The driver used to clone the repository's default HEAD and bake whatever that resolved to as the
build marker, so a build could not prove which commit it built. That is closed: the trusted worker
resolves a full commit SHA for the onboarding row before classification reads any source, and the
build driver checks out that exact SHA and asserts `git rev-parse HEAD` matches before running the
customer's build. The agent's own iteration sandbox checks out the same SHA.

The resolved commit and an optional source-archive digest are stored on the onboarding row, and the
resulting identity (repository, commit, archive digest, plan, every service image digest and
snapshot) is folded into a `build_recipe_digest` that a dynamic `TargetProfile` write refuses to go
without. Remaining work: a trusted controller that stages a source archive so the archive digest is
populated rather than optional.

## Make the registry handoff pluggable, not GHCR-specific

A registry cannot be removed from the design. Daytona turns one of three things into a snapshot:
an image it pulls from a registry, a Dockerfile it builds itself, or a declarative SDK build. The
two build modes run Daytona's own builder with open egress, which the untrusted-build model rules
out, and there is no path that imports a prebuilt image tarball. So the image built inside the
egress-controlled DinD sandbox has to travel through a registry to reach the offline reproduction
snapshot. The question is which registry and how private, not whether.

The coupling to GHCR is thin. The GHCR-specific code is the `docker login/push/logout ghcr.io`
host, the `bountydesk` login, and `GHCR_NAMESPACE` in `daytona-build-driver.ts`. Everything
downstream is already registry-agnostic: `createSnapshot` takes any `registry/name` tag, and a
reproduction pull has been proven against both GHCR and a plain Docker Hub image
(`lib/sandbox/daytona.ts`).

Future work:

- Parameterize the registry as `REGISTRY_HOST`, `REGISTRY_USER`, `REGISTRY_NAMESPACE` and
  `REGISTRY_PUSH_TOKEN`, plus a matching Daytona pull credential. Any OCI registry then plugs in
  with no code change (GHCR, Docker Hub, ECR, GAR, Quay, or self-hosted). Per-medium and
  per-tenant fall out of this: GitHub targets can keep GHCR, email or upload targets point at a
  neutral registry, and each tenant gets its own namespace, all by setting different values.
- Delete the pushed image once `createSnapshot` succeeds. The snapshot is the durable artifact;
  the registry image only needs to exist during the handoff. Deleting it makes the customer's
  code ephemeral in the registry, present for seconds rather than indefinitely. This is the
  largest privacy improvement for the least code, and it works with any registry.
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

## configureTarget requires an active connected repository

`configureTarget` (`lib/targets/configure.ts`) throws
`GitHub repository <id> is not an active connected repository` unless a `connected_repository`
row under a live installation exists. The GitHub App install webhook creates that row; a
hand-driven onboarding, or an email or upload target with no GitHub identity, has none. This is
the per-medium gap from the intake discussion: a non-GitHub target cannot be written today.

Future work: give `configureTarget` a path that binds a target to a `repoId` without a GitHub
`connected_repository`, for email, upload and other non-GitHub sources, while keeping the
connected-repo check for GitHub-sourced targets.

## The build egress allowlist is per-ecosystem

The build driver now selects a bounded per-ecosystem egress allowlist from
`lib/build-onboarding/egress-profiles.ts` and adds only plan-declared extra hosts. The reproduction
sandbox remains offline. New ecosystems or package hosts need an explicit profile and test update; do
not restore a global allowlist that widens every build.

## Resolved

The no-egress oracle now accepts `wget` as well as `curl` (see `classifyEgressProbe` in
`lib/sandbox/provision.ts`), so a target built on a minimal base such as busybox or alpine clears
`verifyNoEgress`. The readiness probe (`waitForAppReady`) accepts `wget` the same way. This removed
the first blockers the live run hit.
