# Deployment plan

Status: manifests added, not live-proven. PR #69 keeps the hosted Vercel deployment as a landing
page only. This branch adds the private worker and TrueForge deployment shape, but the cloud run is
not production-ready until the gates below pass against the real services.

## Local development

Run Next.js, the BountyDesk workers and TrueForge on the development machine. TrueForge listens on
`http://localhost:8790`. Supabase remains the durable database. Daytona may be mocked for ordinary
development; a real account is required for snapshot, isolation, egress and teardown checks. GitHub
webhook testing needs a fresh tunnel URL because tunnel addresses are disposable.

The local worker entry point should exercise the same code that will run after deployment. Do not
add deployment-specific HTTP hops to the local path.

## Cloud deployment

Vercel is the public, stateless tier. It receives authenticated GitHub, email and file-upload
intake, serves the reviewer UI, and hosts the authenticated `publish_verdict` MCP route. Supabase
Postgres stores reports, jobs, leases, sessions, approvals, immutable verdicts and delivery intent.

A Zerops project holds the persistent tier. The committed files are:

- `ops/zerops/project-import.yaml`, which creates a new project with `bdworker`, `trueforge` and
  `tfdata`.
- `ops/zerops/services-import.yaml`, which adds the same services to an existing project.
- `ops/trueforge/package.json` and its lockfile, the pinned TrueForge runtime package.
- `zerops.yml`, which builds and runs the two Node services.
- `scripts/run-trueforge-proxy.mjs`, the bearer-auth proxy in front of TrueForge.
- `scripts/bootstrap-trueforge.mjs`, the private self-bootstrap that configures TrueForge after
  startup.
- `scripts/worker-healthcheck.mjs`, a database health check for manual diagnostics.

The services are:

- A private BountyDesk worker service claims rows from Supabase and drives the four existing queues.
- A private TrueForge service runs in standalone mode with SQLite on Zerops Local Storage. An
  authenticated private proxy in front of its unauthenticated listener checks the bearer token from
  `TRUEFORGE_API_KEY` before forwarding requests.
- The scope-guard MCP service joins the same private network when Track C ships.
- No worker, TrueForge or scope-guard port is exposed publicly. Private ingress is limited to the
  required callers and service ports: the worker may reach the TrueForge proxy, and TrueForge may
  reach scope-guard after Track C ships. The services may make only the outbound calls listed below.

The worker calls the authenticated TrueForge proxy over the Zerops private network and sends
`TRUEFORGE_API_KEY` as its bearer token. The proxy forwards to TrueForge on loopback. The worker
does not provision sandboxes itself: TrueForge provisions its own generic sandbox for the
agent's tool use, and the worker's only other outbound call is to GitHub for approved delivery.
TrueForge calls the model provider and the authenticated MCP route on Vercel. Vercel never calls
TrueForge directly; Supabase is the coordination boundary.

Email and file upload remain independent of GitHub. A report without a server-bound TargetProfile
may receive static analysis but stops at `ANALYSIS_ONLY`. Intake content cannot select a repository,
network destination or sandbox capability.

## Worker process

The deployed worker is a long-running Node entry point from this repository. It imports
`runOnce`, `pollOnce`, `submitApprovalOnce` and `deliverOnce` from `lib/` and runs four independent,
abortable loops. It also runs each queue's expired-lease sweeper.

The worker does not start Next.js and does not curl the `/api/internal/**/tick` routes. Those routes
remain bounded, authenticated adapters for local and manual diagnostics. Shared drain functions
should keep their retry, deadline and sweep behavior aligned with the daemon.

The worker exposes its own `/healthz` listener on `WORKER_HEALTH_PORT` for Zerops liveness checks.
It reports on the loops rather than on the process, because a worker whose loops have all wedged
still answers this port: each loop records when it last finished an iteration, and the check fails
with 503 once one is past its budget, which is what makes the platform restart it. An iteration
that found nothing to claim counts, so an idle queue stays healthy, and the jobs queue has a longer
budget because a single claim there boots a sandbox and waits for it.

Each loop also reports whether its iteration succeeded or threw, because silence is not the only
way to stop doing work. A loop that cannot reach Postgres or TrueForge ticks steadily on its error
backoff and would clear a check that only measures the gap between iterations, so a loop that has
failed every iteration for longer than the failure budget fails the check too, and the response
names it under `failingFor`. One failure means nothing there: the queues absorb a transient error
through leases and retries, and only an unbroken run long enough to mean the dependency is gone
counts. The check is still liveness rather than readiness, so it does not prove a dependency is
reachable before work arrives; an idle worker with a dead Postgres reads as healthy until the first
claim fails.

Each loop needs a distinct owner id, idle backoff, jitter and a fixed concurrency limit. On
`SIGTERM`, the process stops claiming new work and allows the lease protocol to recover anything it
cannot finish.

## First deployment gates

Do not describe the Zerops topology as live or production-ready until all of these pass:

1. A pending TrueForge session and approval survive a service restart and redeploy.
2. SQLite WAL behavior works on the mounted Local Storage volume.
3. `sqlite3 .backup` produces a restorable copy while the service is running.
4. Worker shutdown, restart and expired-lease recovery do not lose or duplicate work.
5. TrueForge and the worker have useful liveness and readiness checks. The worker's liveness side
   is done: `/healthz` fails when a queue loop goes silent, and when one fails every iteration for
   longer than the failure budget. Readiness is not: nothing checks Postgres or TrueForge before
   the first claim, so an idle worker with a dead dependency still reads as healthy.
6. The raw TrueForge agent server has no public access: it binds `127.0.0.1:8790`, and only the
   proxy reaches it. The proxy is the authenticated boundary and is deliberately reachable, so
   the Vercel app can register providers and read harness state through it; it binds `0.0.0.0`
   because the managed host forwards ingress to the container, and it rejects any request without
   the configured bearer token. Private service names still resolve only inside the project.
7. Resource ceilings and billing alerts are set before the services remain online.
8. One real report completes the Track A approval path through the deployed worker.

Start with one TrueForge replica and SQLite. Add Postgres and Valkey only for distributed TrueForge.
Oracle Always Free is an optional disposable experiment, not the deployment target. Its capacity
and allowance can change without changing this architecture.

## Vercel

PR #69 deliberately redirects every non-landing route on Vercel to the GitHub repository. Keep that
behavior for the public landing page by leaving `BOUNTYDESK_LANDING_REDIRECT` unset, or by setting it
to `1`.

For a backend-enabled deployment, set `BOUNTYDESK_LANDING_REDIRECT=0` in Vercel after the database,
GitHub App, worker and TrueForge are ready. The health endpoint `/api/health` is always allowed
through the landing redirect so the public tier can be checked without exposing authenticated pages.

Required Vercel environment:

```bash
DATABASE_URL=
APP_BASE_URL=
GITHUB_WEBHOOK_BASE_URL=
AUTH_SECRET=
REVIEWER_GITHUB_IDS=
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_WEBHOOK_SECRET=
GITHUB_APP_PRIVATE_KEY_BASE64=
WORKER_INTERNAL_SECRET=
MCP_SERVER_SECRET=
SCOPE_GUARD_URL=
SCOPE_GUARD_TOKEN=
DAYTONA_API_KEY=
DAYTONA_TARGET_SNAPSHOT_ID=
DAYTONA_TARGET_IMAGE_DIGEST=
BOUNTYDESK_LANDING_REDIRECT=0
```

Run BountyDesk migrations from a trusted machine or CI job, not from a Vercel function:

```bash
npm ci
DIRECT_URL="<supabase-direct-or-session-pooler-url>" npm run db:migrate
```

## Zerops

The local CLI is `zcli`. Create the private services from this repo:

```bash
zcli project project-import ops/zerops/project-import.yaml
```

If you already created a BountyDesk project by hand, import the services instead:

```bash
zcli project service-import ops/zerops/services-import.yaml -P <project-id>
```

Set these secrets on `bdworker` before the first deploy:

```bash
DATABASE_URL=
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY_BASE64=
MCP_SERVER_SECRET=
TRUEFORGE_API_KEY=
DAYTONA_API_KEY=
DAYTONA_TARGET_SNAPSHOT_ID=
DAYTONA_TARGET_IMAGE_DIGEST=
```

Set this secret on `trueforge` before the first deploy:

```bash
TRUEFORGE_API_KEY=
OPENAI_API_KEY=
DAYTONA_API_KEY=
APP_BASE_URL=
MCP_SERVER_SECRET=
SCOPE_GUARD_URL=
SCOPE_GUARD_TOKEN=
```

The `zerops.yml` file sets `TRUEFORGE_URL=http://trueforge:8791` for the worker. Do not expose the
`trueforge` service subdomain. The only caller should be `bdworker` over the Zerops private network,
using `TRUEFORGE_API_KEY` as a bearer token.

The TrueForge proxy refuses wildcard bind hosts. In Zerops the proxy binds to `127.0.0.1` for
readiness and bootstrap, plus the service container's concrete interface address so `bdworker` can
use the private `trueforge` hostname without opening the proxy on every interface.

With the current `zcli`, service secrets are easiest to set at project creation time with
`envSecrets` in a private import stream, or later through the Zerops dashboard bulk editor. Do not
commit a secret-bearing import file.

Deploy both private services after the secrets are present:

```bash
zcli push bdworker -P <project-id>
zcli push trueforge -P <project-id>
```

Then configure the TrueForge instance from the private service or through a temporary private access
path:

```bash
npm run skills:apply
npm run agent:apply
```

Those commands need `TRUEFORGE_URL` to point at the authenticated proxy and `TRUEFORGE_API_KEY` to
match the proxy secret.

## First cloud run

The first cloud run should use the connected Juice Shop fork from `env.example`. After the Daytona
snapshot has been built and verified, bind the connected repository:

```bash
npm run seed:target -- 1347703889
```

Then create a GitHub issue with a reviewer-authored `/reproduce` command, approve only through the
BountyDesk UI, and verify there is one verdict row, one outbound delivery and one GitHub comment with
the BountyDesk delivery marker.
