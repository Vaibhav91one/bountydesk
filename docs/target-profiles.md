# Target profiles and dynamic target setup

BountyDesk treats a test repository as source for a pinned target application, not as the
authority for reproduction. The platform owns the target profile, the Daytona snapshot, the
readiness check, the scope guard, and the approval-gated tools the agent can call.

The current implementation keeps the frozen Juice Shop demo target in
`lib/targets/registry.ts`, and lets every other target come from a validated manifest. A
manifest can be written by an onboarding agent, a build job, or an operator, but it is still
only a proposal until BountyDesk parses it and combines it with a verified image digest,
snapshot id and build marker.

The operator path is:

```bash
npm run seed:target -- <github-repository-id> [target-profile-name]
npm run seed:target -- <github-repository-id> --manifest .bountydesk/target.json
```

Rotation uses the same shape:

```bash
npm run rotate:target -- <github-repository-id> [target-profile-name]
npm run rotate:target -- <github-repository-id> --manifest .bountydesk/target.json
```

`target-profile-name` defaults to `juice-shop-v17.3.0`, so the original demo flow still works
without a manifest. Dynamic targets read these environment variables, where `<TARGET>` is the
manifest `envPrefix`, or the manifest name uppercased with non-alphanumeric characters changed
to underscores:

```text
BOUNTYDESK_TARGET_<TARGET>_IMAGE_DIGEST
BOUNTYDESK_TARGET_<TARGET>_SNAPSHOT_ID
BOUNTYDESK_TARGET_<TARGET>_BUILD_MARKER
BOUNTYDESK_TARGET_<TARGET>_SNAPSHOT_IMAGE_REF
```

The build marker is required unless the registry entry has a baked-in marker. The snapshot
image reference is optional and exists for Daytona snapshots that are tag-pinned in the control
plane while the platform still verifies the booted image by reading the build marker inside the
sandbox.

The manifest shape is intentionally small:

```json
{
  "name": "webgoat",
  "repoFullName": "Vaibhav91one/WebGoat",
  "imageName": "ghcr.io/vaibhav91one/webgoat",
  "baseUrl": "http://localhost:8080",
  "readinessPath": "/WebGoat",
  "startCommand": "java -jar /opt/webgoat/webgoat.jar"
}
```

Validation rejects non-loopback base URLs, tagged image references, malformed names, overbroad
scope rules, and multiline startup commands. Today scope rules may only allow `localhost`.

No target repository should need `detect.sh` or any other reproduction shell script. If a repo
needs app startup behavior, put that command in the reviewed target manifest. The agent
investigates through the harness with `probe_target` and `probe_target_write`; it should not
run repo-provided reproduction scripts as the source of truth.

## Dynamic setup feature

Dynamic setup automates the operator work above without changing the trust model. The flow for a
connected GitHub repository is:

1. The GitHub App installation creates or updates the connected repository row.
2. A build worker claims the repo and clones it in a build sandbox with dependency egress. A public
   repository clones anonymously. A private one is queued only when its installation has accepted
   Contents: read, and clones with a single-repository, contents:read installation token passed
   through a credential helper and revoked after the clone; without the permission nothing is
   cloned and reproduction ends `ANALYSIS_ONLY` with `POLICY_REFUSED`.
3. The worker reads or asks an onboarding agent to propose the target manifest. The proposal
   only identifies framework, port, health path, image name and start command.
4. The worker builds the target image, writes a build marker into it, pushes it through the
   registry handoff (GHCR by default, any registry through `REGISTRY_*`), and registers a Daytona
   snapshot. Once the snapshot is active the pushed image is deleted when a delete token is
   configured. After a reviewer approves the manifest, the worker boots the snapshot offline with
   the proposed start command and checks readiness before writing anything.
5. The platform writes or rotates the server-side `TargetProfile` and binds the connected repo
   to it.
6. Report intake can then create bound reports for that repo. Reproduction still runs in a
   no-egress sandbox and the agent still reaches the app only through the approval-aware tools.

The dynamic build sandbox is not trusted. It may run customer code and download dependencies,
so only the built artifact and explicit metadata should cross into the reproduction sandbox.
The reproduction sandbox stays offline except for the platform's preview tunnel, and the human
approval gate remains unchanged.

If the target cannot be built or deployed, reproduction does not start. The report gets a
read-only static review of the source instead and ends `ANALYSIS_ONLY` (`docs/decisions.md` Q31).

## Targets without a connected repository

A target can also come from a source with no GitHub identity: an archive with a Dockerfile at its
root, a single Dockerfile, or a prebuilt image named by tag and sha256 digest. Today these arrive
through upload intake, and a reviewer states the port, readiness path, optional start command and
build ecosystem before anything builds. The build driver stages the source (an archive is re-hashed
in the sandbox before unpacking; a prebuilt image becomes `FROM <name>@<digest>` with the digest
baked in as the build marker), and `configureConnectionlessTarget` writes the profile with no
connected repository. The identity anchor is a commit SHA, a source archive digest or the image
digest, whichever the source has. A prebuilt image must come from a registry on
`PREBUILT_IMAGE_REGISTRIES` (default `docker.io,ghcr.io`), because its registry joins the build
egress allowlist. Scope is loopback only, as for every target. A connectionless profile cannot be
rotated yet; see `docs/onboarding-follow-ups.md`.

Artifacts are intentionally separate from this target-profile flow. A future artifacts feature
can attach logs, screenshots, or request traces to the platform case file, but it should not
make a repo-local script authoritative for `REPRODUCED` or `NOT_REPRODUCED`.
