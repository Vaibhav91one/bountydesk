# Packaging a target repo

A target is a passive test application BountyDesk builds once, snapshots, and boots offline to
reproduce a report against. This is the contract a repo has to meet to be onboarded, and the recipes
for the common shapes. The default reproduction path boots one image with no network (see
`docs/decisions.md` Q16, Q18 and Q23). A reviewed compose-mesh plan is the narrow exception: it
boots one pinned sandbox per service in a private linked group, while every node remains offline.

## The contract

An onboardable single-image target produces one image that:

- serves HTTP on a single port bound to `0.0.0.0` (the sandbox probes `127.0.0.1`, so a
  loopback-only bind is not reachable),
- boots with no outbound network: no package installs, no image pulls, no calls home at start,
- has its datastore, if any, inside the image with the schema and any fixture data seeded at build
  time, not created on first boot and not behind a human "set up the database" click,
- answers a readiness path with a 2xx once it is up,
- starts from one command or entrypoint that launches the datastore (if any) and then the app.

A compose-mesh target instead has one app service and one or more dependencies. Each service gets a
pinned image and Daytona snapshot. Reproduction creates the app as the parent and dependencies as
linked children with `networkBlockAll: true`; service names are wired through the private link, not
through Docker or runtime image pulls. The worker verifies egress on every node and build markers on services built from repository source;
stock image services intentionally have no repository marker. It starts dependencies before the app and
tears down the whole group on failure. Only the app sandbox
is stored in the agent session and exposed to `probe_target`. Dependencies are internal capability,
not additional agent targets.

If a repo cannot be reduced to that, it is not rejected outright: it falls to the reachability
pre-check for an evidenced analysis-only verdict, or, with an explicit opt-in, to reaching a running
instance the customer already operates. Prefer the offline image whenever the app can be packaged
into one, because only that path earns a reproduced verdict.

## The four build strategies

The onboarding classifier picks one and records it in the build plan
(`lib/build-onboarding/build-plan.ts`).

### dockerfile

The repo's own Dockerfile already builds a self-contained image. The plan can point at a Dockerfile
that is not at the root, build from a subdirectory, and pass non-secret build args. DSVW and Juice
Shop are this shape. Nothing to author; the repo is ready.

### image

The target is a published all-in-one image. The plan is `FROM <image>` plus the build marker, and
the image is pinned to a digest at build time. Use this when a good single-container image already
exists (for DVWA, the community `vulnerables/web-dvwa` bundles Apache, PHP and MariaDB in one
container). The image's registry host has to be in the build egress allowlist.

### compose-synth

The repo ships a `compose.yml` with one service that serves HTTP and one or more datastores. The
compiler reads the compose file and, for the supported shape (one app service plus datastores from a
known set: MariaDB/MySQL, Postgres, Redis), synthesizes a self-contained Dockerfile that installs
the datastore into the app image, points the app at `127.0.0.1`, seeds at build, and starts both.
Anything outside that shape (two app services, an unknown service image, host networking) is
`not-flattenable` for compose-synth and is considered for the mesh path.

### compose-mesh

A multi-service compose file can use `compose-mesh` when it has one identifiable HTTP front door and
services that can be built or pulled ahead of time. The classifier records the service graph, the
build worker produces one digest-pinned snapshot per service, and the reproduction worker links the
sandboxes privately. The mesh never runs Compose or a Docker daemon at reproduction time.

The admitted subset is deliberately narrow. Accepted: `build.context` with a Dockerfile path,
published or exported ports, map or list `environment`, `depends_on` by name, and env values that
name another service, including defaulted interpolation such as `${DB_HOST:-db}`.

Refused rather than quietly dropped, because the offline linked-sandbox model has no equivalent:

- a second service that publishes an HTTP port, when no explicit app is named. Two published front
  doors are ambiguous, and silently naming one the app would stop probing the other. The mesh accepts
  a named app through the reviewer's hint instead.
- `privileged: true`, `network_mode: host`, `cap_add`, `devices`, `pid: host`.
- absolute or traversal build paths, and a Dockerfile path that escapes its context.
- an image reference whose interpolation cannot be resolved to a concrete value, and a bare `$VAR`.
- a peer that names a service the file does not declare.
- a host-level start command such as `docker run`, `docker compose`, `podman` or `nerdctl`.

A service listening only on the internal network (`expose`) is admitted as a dependency; when exactly
one candidate is published and the rest are only exposed, the published one is the app.

## Build egress is per ecosystem

The build sandbox has narrow, allowlisted egress so the customer's untrusted Dockerfile can fetch
its dependencies and nothing else. The allowlist is chosen from the detected ecosystem
(`lib/build-onboarding/egress-profiles.ts`): npm for Node, PyPI for Python, the Debian mirrors plus
Packagist for PHP, Maven Central plus a JDK source for Java, and so on. A repo that fetches from an
unlisted host adds it through the plan's `extraEgressHosts`; the build fails closed with the blocked
host in the log if a host is missing, so the fix is to name it and rebuild.

## Worked example: DVWA through compose-synth

DVWA (`digininja/DVWA`) ships a `compose.yml` with a PHP app service built from its own Dockerfile
and a separate MariaDB service. It cannot run as-is offline, because the app service alone has no
database. The compiler turns it into one image:

1. Read `compose.yml`. The app service is the one exposing the HTTP port and carrying a build
   context; the `db` service's image is MariaDB, so it maps to the MariaDB datastore recipe. The
   database name, user and password come from the `db` service's own environment, so the app's
   config keeps matching them.
2. Synthesize a Dockerfile: build the app from its context, install MariaDB into the same image
   (`lib/build-onboarding/datastore-recipes/mariadb.ts`), and rewrite the app's `config.inc.php`
   database host from the compose service name to `127.0.0.1`.
3. Seed at build. The plan's seed step is an HTTP GET to `/setup.php`, DVWA's own database creation
   endpoint. The build starts MariaDB, brings the app up, hits `/setup.php` so the tables and seed
   rows are written into `/var/lib/mysql`, then stops both. That data directory is now a layer in
   the image, so a fresh offline sandbox boots with the database already populated.
4. Set the entrypoint to start `mariadbd`, wait for it, then start Apache. The plan's
   `warmupSeconds` gives readiness a longer budget because MariaDB starts before the app answers.

The result is one image the reproduction sandbox boots offline, with a working, pre-seeded database,
built from DVWA's own compose file and no hand-written Dockerfile. This is the same shape Sentinel's
`sandbox-setup/dvwa.sh` produced at runtime, moved to build time and pinned.

DVWA's reproduction recipe (its session, `security=low` cookie, form-encoded POST and per-module
canary) is separate work and is tracked with the other reproduction oracles; onboarding a target to
`CONFIGURED` is what this cookbook covers.

## Adding a datastore recipe

A new datastore is a file in `lib/build-onboarding/datastore-recipes/` giving three things: the
install commands for the ecosystem's package manager, the build-time start/seed/stop sequence, and
the boot command the entrypoint runs. It is data, not new pipeline code, so a Postgres- or
Redis-backed app is a recipe away from onboarding through the same compiler.
