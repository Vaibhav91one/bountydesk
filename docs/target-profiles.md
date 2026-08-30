# Target profiles and future dynamic target setup

BountyDesk treats a test repository as source for a pinned target application, not as the
authority for reproduction. The platform owns the target profile, the Daytona snapshot, the
readiness check, the scope guard, and the approval-gated tools the agent can call.

The current implementation uses a server-side target registry in `lib/targets/registry.ts`.
Each entry names the GitHub repo, image name, local base URL, readiness path, scope rules, and
any command needed to start the app inside the reproduction sandbox. The operator still has to
build and verify the image and snapshot first, then bind the connected repo with:

```bash
npm run seed:target -- <github-repository-id> [target-profile-name]
```

Rotation uses the same target name:

```bash
npm run rotate:target -- <github-repository-id> [target-profile-name]
```

`target-profile-name` defaults to `juice-shop-v17.3.0`, so the original demo flow still works.
Other targets read these environment variables, where `<TARGET>` is the registry entry's
`envPrefix`:

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

No target repository should need `detect.sh` or any other reproduction shell script. If a repo
needs app startup behavior, put that command in the platform registry or, later, in a reviewed
target manifest that the platform ingests. The agent investigates through the harness with
`probe_target` and `probe_target_write`; it should not run repo-provided reproduction scripts
as the source of truth.

## Dynamic setup feature

The dynamic version should automate the operator work above without changing the trust model.
The expected flow is:

1. The GitHub App installation creates or updates the connected repository row.
2. A build worker claims the repo and clones it in a build sandbox with dependency egress.
3. The worker reads a reviewed target manifest, or falls back to a constrained detector that
   only identifies framework, port, health path, and build command.
4. The worker builds the target image, writes a build marker into it, registers a Daytona
   snapshot, then verifies the snapshot can boot.
5. The platform writes or rotates the server-side `TargetProfile` and binds the connected repo
   to it.
6. Report intake can then create bound reports for that repo. Reproduction still runs in a
   no-egress sandbox and the agent still reaches the app only through the approval-aware tools.

The dynamic build sandbox is not trusted. It may run customer code and download dependencies,
so only the built artifact and explicit metadata should cross into the reproduction sandbox.
The reproduction sandbox stays offline except for the platform's preview tunnel, and the human
approval gate remains unchanged.

Artifacts are intentionally separate from this target-profile flow. A future artifacts feature
can attach logs, screenshots, or request traces to the platform case file, but it should not
make a repo-local script authoritative for `REPRODUCED` or `NOT_REPRODUCED`.
