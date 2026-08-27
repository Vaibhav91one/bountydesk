# Spike: can BountyDesk provision a Daytona sandbox directly?

Run 2026-08-27. Time-boxed and narrow: no `AnalysisDriver`, no dynamic repository tier, no
issue-triggered workflow, no proof-of-concept execution. One question, answered with evidence.

## Conclusion

**Pass.** BountyDesk can provision an ephemeral sandbox from a named snapshot, observe what
actually booted, run a fixed command inside it, show from inside that the sandbox reaches
nothing, and destroy it again.

The interesting part is not the pass. It is that "no egress" turned out to mean an interception
proxy answering 403 rather than an absent route, and that the control plane exposes no image
digest at all. Both change what the later gates can honestly claim.

Nothing in `env.example` was replaced with a real identifier: the connected fork has not been
built, so there is still no target snapshot to name.

## What was proved

Provisioned from snapshot `dad882b3-a047-4715-8713-bddec50bb7ca` (`daytona-small`,
`daytonaio/sandbox:0.9.0`). A generic snapshot on purpose: the question was whether the
mechanism works, and building the target image before knowing that would have been the
expensive order to find out.

| step | evidence |
| --- | --- |
| requested snapshot | `dad882b3-a047-4715-8713-bddec50bb7ca` |
| snapshot record | `daytona-small`, image `daytonaio/sandbox:0.9.0`, state `active`, cpu 1, mem 1, disk 3 |
| sandbox id | `589f669d-84f7-4b78-b73a-b3c29cbcf7dc` |
| reached state | `started` |
| observed snapshot | `daytona-small` |
| **`networkBlockAll`** | **`true`** |
| network and domain allow lists | `null` |
| sandbox class | `container` |
| runner | `f6ffe6c0-faea-4339-b2cd-bcbf6f478221` |
| fixed command | exit `0`, stdout `bountydesk-spike-ok` |
| teardown | delete succeeded, second delete also succeeded, `GET` then 404s, label sweep empty |

Egress, probed from inside the sandbox:

| probe | result |
| --- | --- |
| `https://example.com` | curl 28, DNS resolution timed out |
| `https://1.1.1.1` (no DNS involved) | curl 35, connection reset by peer |
| `169.254.169.254/latest/meta-data/iam/security-credentials/` | **403** `Internet is restricted on Tier 1 and Tier 2.` |
| `169.254.169.254/computeMetadata/v1/` with `Metadata-Flavor: Google` | **403**, same |
| `100.100.100.200` (Alibaba metadata) | **403**, same |
| `https://app.daytona.io/api/health` | curl 28, DNS resolution timed out |

No probe reached its destination, and no credential material came back from any metadata
address.

Six of the eight rows in the first table are assertions rather than observations: the run
throws if the booted snapshot is neither the resolved id nor the name, if `networkBlockAll`
comes back false, if either allow list is non-empty, if the fixed command does not run, or if
any probe gets a 2xx or 3xx. The snapshot record, runner id and sandbox class are recorded but
not asserted, because they are context rather than claims.

`sandbox_class: container` is the shared-kernel container the threat model already describes,
which is a confirmation rather than a surprise. It is not an adversarial boundary, and the
board's demo-versus-production caveat stands unchanged.

## Provider behaviour that changes the documented topology

**1. Resource limits belong to the snapshot, not the request.** `POST /api/sandbox` refuses a
create that carries `cpu`, `memory` or `disk` alongside a snapshot: *"Cannot specify Sandbox
resources when using a snapshot"*. So limits cannot be requested per run. The client now reads
the snapshot, compares its declared limits against what the run expects, and refuses both a
mismatch and a snapshot that declares nothing. Recording a cap that was never applied would
make an evidence packet untrue, so this inverts to verification rather than a request.

This contradicts the planned `env.example` shape, where build and reproduction limits were
going to be per-run settings. They have to be baked in when the snapshot is created.

**2. Egress is blocked by an interception proxy, not by an absent route.** The sandbox has a
default route, a resolver, and a search domain naming the underlying cloud. Requests leave and
are answered by an Envoy that returns `403 Internet is restricted on Tier 1 and Tier 2.`
Metadata addresses are answered the same way.

Practically this is fine: nothing reached its destination and no credentials came back. But it
means the property is enforced by someone else's policy engine rather than by the absence of a
path, and curl exits `0` on a blocked request because a 403 is a successful HTTP transaction.
The first version of this spike used exit status as the test and would have called a reachable
metadata endpoint a pass. The gate now reads the status line: anything 2xx or 3xx is the
destination answering, and that is the failure.

Consequence for the threat model: "the reproduction sandbox has no network" is a claim about
Daytona's configuration, verified per run from inside, not a structural guarantee. Verifying it
per run is the mitigation, and there is no cheaper one available at this tier.

**3. There is no resolved image digest anywhere in the control-plane API.** `SnapshotDto` has
`imageName` and `ref`; the `Sandbox` response has neither a digest nor an image. Searching the
whole OpenAPI document for a digest-shaped field returns only `DaytonaConfiguration.buildSha`,
which is Daytona's own build.

An earlier draft of this record said the digest could be verified from inside the sandbox
instead. That is wrong, and worth stating plainly: an ordinary unprivileged container cannot
read the OCI manifest digest the host runtime used. What actually works is a chain of weaker
links, each of which has to be recorded for what it is:

- Build outside, and record the generated digest there. This is the authoritative value.
- Create the snapshot from `image@sha256:…`, a digest-pinned reference.
- Require the snapshot record's `imageName` to equal that exact expected reference, string for
  string, at provisioning time.
- Verify a defender-authored build marker inside the running target. This proves the artifact
  came from our build, not that the manifest digest matches.

What remains is residual trust in the provider: nothing available to us proves the runtime
artifact resolved to the pinned digest. Document that, rather than claiming the sandbox can
establish its own provenance.

**4. Teardown is not immediately available.** A freshly started sandbox answers `DELETE` with
`409 Sandbox state change in progress`. The first version of this spike leaked a sandbox
exactly that way, from a `finally` block, which is the worst place to discover it.
`deleteSandbox` now retries on 409 with backoff and treats 404 as success. That makes it
best-effort, not a guarantee: a process that dies still leaks, so the provider TTL and a
reconciler remain necessary rather than belt-and-braces. The listing also lags a delete, so a
sandbox already confirmed gone can still appear in a label sweep.

## A correction

An earlier revision of this spike recorded that the toolbox rejects the organisation API key
with 401 and needs a per-sandbox credential the control plane does not expose. That was wrong.
The URL was malformed: it carried two spurious `/toolbox` segments. The official SDK builds the
base as `<toolboxProxyUrl>/<sandboxId>` and the generated process client appends
`/process/execute`, using the same organisation key. With the correct path the command runs and
exits 0. No separate credential exists or is needed.

The finding is left in the record rather than deleted, because a spike that only keeps its
correct conclusions is not evidence of anything.

## What this does not prove

One live run, on one runner, with a generic snapshot. Teardown worked here; the provider TTL
expiring on its own and the reconciler sweeping an abandoned sandbox are both still untested,
and "destroy it reliably" is a stronger claim than a single successful run supports.

The remaining gates from `docs/decisions.md` are untouched: a `TargetProfile` selecting the
exact snapshot, the built artifact matching the connected commit, the digest chain above,
starting the target with no runtime downloads, restricted build egress, and reconciliation of
abandoned sandboxes. Reproduction egress and command execution are the two now evidenced.

Next, in order: build the connected fork at `1867b926c5f50e4e692dc9c8f61821413cebe0cd`, record
its generated digest, create a digest-pinned snapshot from it, and re-verify both frozen
scenarios against that image before calling it the demo target.

## Reproducing this

```
npm run spike:daytona -- <snapshot-id-or-name>
```

Creates one reproduction-class sandbox with no network and a ten-minute TTL, asserts each gate,
and always attempts teardown. Every identifier comes from the argument or from the script;
nothing is read from a report, and no platform secret enters the sandbox.

`lib/sandbox/daytona.ts` provisions reproduction sandboxes and nothing else. There is no build
class, because a build sandbox needs a dependency egress allow list and the only trustworthy
source of those hosts is a `TargetProfile` that does not exist yet. An allow-list argument with
nowhere to get its value from reads as a control while being a hole, so the capability is
absent rather than validated, and the file consequently has no argument anywhere that grants a
sandbox network access. It comes back with the build tier, sourced from the profile.

The create names the id the snapshot lookup returned, not the string the caller passed. A
caller may pass a mutable display name, and one repointed between the lookup and the create
would otherwise hand back a sandbox built from something other than the snapshot whose state
and limits were just checked.
