# Dockerless targets

Research note for issue #213. It is a desk study: I read the onboarding code and searched for
buildpack documentation, and I did not run onboarding, Daytona or TrueForge against any repository.
Every claim about agent behaviour below is reasoning from the code, not an observation, and the
section on what to test says how to turn it into one.

## The current limit

`classify` (`lib/build-onboarding/classify.ts`) returns a build plan for three shapes: a compose
file that flattens, a compose file that becomes a linked mesh, or a bare Dockerfile. A repo with
none of them gets `not-flattenable` with the reason "repo has neither a Dockerfile nor a flattenable
compose file".

That is not the end of the road. In `onboardOnce` (`lib/build-onboarding/worker.ts`) a
`not-flattenable` plan first goes to the sandboxability review, and unless the review says "no" it
falls through to `runOnboardingAgent`. The agent opens a Docker-in-Docker build sandbox, iterates a
Dockerfile until the app boots offline and answers a data-backed request, then calls
`commit_target_image`. The result is stored as an `agent-authored` plan (`build-plan.ts`) holding
the full Dockerfile text. The driver rebuilds that text for the pinned, digest-checked artifact.

So a plain Express, Flask or Go repo with no Dockerfile is already a "dockerless in, Dockerfile out"
case. Only when the agent gives up (`mark_unsandboxable`) or the review says "no" does the report
end `ANALYSIS_ONLY`.

## Why running from source at reproduction time does not work

Reproduction runs under `networkBlockAll` with `verifyNoEgress` and `buildMarkerCheck`, and the
pins assume a baked snapshot. Installing npm, pip or bundler dependencies at start needs network, so
"boot from source in the reproduction sandbox" breaks the offline invariant. The only workable
shape keeps the dependency fetch in the build sandbox, which already has the narrow per-ecosystem
allow-list in `egress-profiles.ts`, and ships a built artifact. Everything below is about that
shape.

## Findings per approach

### Cloud Native Buildpacks (`pack`)

Produces an OCI image from source with no author-written Dockerfile, using a builder such as
Paketo's. The build needs a Docker daemon, which the build sandbox already is. Dependency download
happens inside the build phase, so it fits the existing narrow-egress window: allow the ecosystem
hosts, run `pack build`, push, and snapshot. The finished image runs with no network, since
buildpacks bake dependencies into layers.

Costs and caveats:

- The builder and run images are large and are pulled from a registry. The registry hosts would
  join the egress allow-list, and the builder image becomes another thing to pin by digest.
- The image's entrypoint is a launcher process driven by a process type. It works under
  `startCommand` being unset, but readiness port and path still need to be found.
- Some buildpacks fetch runtimes from vendor hosts at build time (JDK, Node, Python distributions),
  so egress profiles would grow per builder, not just per ecosystem.
- I did not verify any of this against a running `pack`.

### Nixpacks

Nixpacks is in maintenance mode and Railway has replaced it with Railpack (sources: the Railway
Central Station threads and the Coolify migration issue #7983 turned up by search). Building the
integration on a deprecated tool is a poor bet. Railpack is the successor, still young (beta since
March 2026 according to the same results), and it builds through BuildKit, which would need to be
available in the build sandbox. I treat it as a watch item, not a candidate.

### Heroku buildpacks

The current Heroku builders implement the Cloud Native Buildpacks spec, so this is the same
integration as `pack` with a different builder. Nothing extra to evaluate separately beyond builder
size and which language hosts it fetches from.

## Identity, offline and start command

Identity is not the blocker. `hasIdentityAnchor` (`lib/build-onboarding/source-identity.ts`) accepts
a commit SHA, a source archive digest or an image digest. A dockerless build resolves the commit
before any customer code runs (`resolveRepositoryCommit`), exactly as the existing paths do, and
the marker baked into the image is that commit. The `agent-authored` path already does this today.

Offline holds for any approach that bakes dependencies in the build sandbox and ships an image.
The final boot is checked by the same `verifyNoEgress` and marker check as every other strategy,
because both consume a registered snapshot and do not care how it was built.

Start command and readiness are the real soft spot. A dockerless repo has no `CMD` and no
`EXPOSE`, so someone has to infer the command, the port and a readiness path. The manifest
(`lib/targets/manifest.ts`) already carries `startCommand` and `readinessPath`. The agent infers
them by trying and watching the app boot, which is more reliable than a deterministic guess from
`package.json` scripts. A buildpack removes the image-assembly step but not this inference, so it
saves less than it appears to. When inference fails the safe outcome is the existing one: no
snapshot, `ANALYSIS_ONLY`.

## Is improving the agent cheaper than a buildpack integration

From the code, yes. The agent path already exists end to end: egress profiles per ecosystem,
digest-pinned rebuild, marker, snapshot, and the offline boot check. A buildpack strategy would add
a new plan strategy, a builder pin and its egress hosts, a parser change, driver changes, and tests
on security-sensitive paths (egress and the build marker). The agent needs no new code for the
common case. At most it needs prompt or tooling work, for example hints of the form "for a repo
with no Dockerfile, start from the official language base image and find the start command from
the manifest".

The one thing a buildpack would buy is determinism: no model turn, so lower latency (the agent turn
can run up to 25 minutes, `TURN_DEADLINE_MS`) and no run-to-run variance. That matters only if the
agent proves slow or flaky on ordinary repos, which I have no data on.

## Cost assessment

- Agent path: zero build cost now. Ongoing cost is model turns and variance.
- Buildpack strategy: a bounded but real feature, roughly a new strategy in `build-plan.ts` and
  `daytona-build-driver.ts`, a builder digest pin, per-builder egress hosts, and tests. Larger
  images raise snapshot storage and cold start. It also adds a second way to reach a snapshot to
  keep correct whenever the pin or marker rules change.
- Neither option changes the reproduction sandbox or the human gate.

## Recommendation

NO-GO on a buildpack integration for now, with a reopen condition.

1. The common dockerless case is, by code reading, already covered by the agent-authored path.
2. Buildpacks do not remove the hard part, inferring the start command and port.
3. Nixpacks is deprecated, and the CNB route adds large pinned images and per-builder egress.
4. The cheap, useful work is measuring the agent on real repos and tightening its prompt.
5. Reopen as a bounded spike if the agent fails or is too slow on ordinary repos, with a CNB builder
   (Paketo or Heroku) as the first candidate, not Nixpacks.

This agrees with the earlier hold recorded on the issue.

## What to test before committing to anything

No live runs were performed for this note. Before treating the NO-GO as settled, run the existing
onboarding path on three dockerless repos (a plain Express app, a Flask app, and a Go module with
no Dockerfile) and record, for each: whether the agent reaches `commit_target_image`, wall time,
how many build iterations it needed, whether the start command and readiness path it chose are
right, and whether the snapshot then passes the offline boot check. If two of three succeed in
reasonable time, close the issue as covered. If the agent fails on the start command more than on
the build, a buildpack would not help either, and the fix is in the agent's prompt.
