# Spike: can BountyDesk provision a Daytona sandbox directly?

Run 2026-08-27. Time-boxed and narrow: no `AnalysisDriver`, no dynamic repository tier, no
issue-triggered workflow, no proof-of-concept execution. One question, answered with evidence.

## Conclusion

**Pass, with one gate not yet cleared.** BountyDesk can provision an ephemeral sandbox from a
named snapshot, observe what actually booted, confirm the reproduction network policy, and
destroy it reliably. Running a command inside it needs a credential the control-plane API does
not hand out, and that is the next thing to resolve.

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
| sandbox id | `f8814fa2-536b-498b-bcde-4d45c4647997` |
| reached state | `started` |
| observed snapshot | `daytona-small` |
| **`networkBlockAll`** | **`true`** |
| network allow list | `null` |
| domain allow list | `null` |
| sandbox class | `container` |
| runner | `b5b7fc53-adc4-43b6-9cc2-1951ee2dad68` |
| execute with org key | **HTTP 401** |
| teardown | delete succeeded, second delete also succeeded, subsequent `GET` 404s |

Verified afterwards: **zero** sandboxes in the account carry a `bountydesk.*` label, so the
spike leaked nothing.

`sandbox_class: container` is the shared-kernel container the threat model already describes,
which is a confirmation rather than a surprise. It is not an adversarial boundary, and the
board's demo-versus-production caveat stands unchanged.

## Provider limitations that change the documented topology

**1. Resource limits belong to the snapshot, not the request.** `POST /api/sandbox` refuses a
create that carries `cpu`, `memory` or `disk` alongside a snapshot: *"Cannot specify Sandbox
resources when using a snapshot"*. So limits cannot be requested per run. The client now reads
the snapshot, compares its declared limits against what the run expects, and refuses a
mismatch. Recording a cap that was never applied would make an evidence packet untrue, so this
inverts to verification rather than a request.

This contradicts the planned `env.example` shape, where build and reproduction limits were
going to be per-run settings. They have to be baked in when the snapshot is created.

**2. There is no resolved image digest anywhere in the control-plane API.** `SnapshotDto` has
`imageName` and `ref`; the `Sandbox` response has neither a digest nor an image. Searching the
whole OpenAPI document for a digest-shaped field returns only `DaytonaConfiguration.buildSha`,
which is Daytona's own build.

So `env.example`'s instruction that "provisioning must reject a snapshot whose resolved image
digest differs from this value" cannot be satisfied from the control plane. Two honest options,
and they compose: pin the snapshot's `imageName` to an `@sha256:` reference when creating it and
compare that string, and verify the digest from inside the sandbox at run time. The second is
the one that answers "what actually booted" rather than "what was requested".

**3. Teardown is not immediately available.** A freshly started sandbox answers `DELETE` with
`409 Sandbox state change in progress`. The first version of this spike leaked a sandbox
exactly that way, from a `finally` block, which is the worst place to discover it. `deleteSandbox`
now retries on 409 with backoff and treats 404 as success. That makes it best-effort, not a
guarantee: a process that dies still leaks, so the provider TTL and a reconciler remain
necessary rather than belt-and-braces.

**4. The toolbox rejects the organisation API key.** Command execution goes through
`toolboxProxyUrl` (`proxy.app-eu.daytona.io`), and it answers `401 Bearer token is invalid` for
the organisation key on every path tried. The control-plane schemas expose no per-sandbox auth
token; the official SDK evidently mints one. Left unresolved on purpose: guessing at an
undocumented auth scheme is how a time-boxed spike turns into a rewrite.

## What this gates

The remaining gates from `docs/decisions.md` are untouched by this run: a `TargetProfile`
selecting the exact snapshot, the built artifact matching the connected commit, digest
verification, starting the target with no runtime downloads, restricted build egress,
unreachable cloud metadata, and reconciliation of abandoned sandboxes. Reproduction egress is
the one now evidenced, and only for a sandbox created as `reproduction`.

Next, in order: resolve the toolbox credential, then build the connected fork at
`1867b926c5f50e4e692dc9c8f61821413cebe0cd` and record its generated digest, then re-verify both
frozen scenarios against that image before calling it the demo target.

## Reproducing this

```
npm run spike:daytona -- <snapshot-id-or-name>
```

Creates one reproduction-class sandbox with no network and a ten-minute TTL, prints the
evidence, and always attempts teardown. Every identifier comes from the argument or from the
script; nothing is read from a report, and no platform secret enters the sandbox.
