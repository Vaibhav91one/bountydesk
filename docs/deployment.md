# Deployment plan

Status: designed, not built. Continue local development until the deployment gates below pass.

## Local development

Run Next.js, the BountyDesk workers and TrueForge on the development machine. TrueForge listens on
`http://localhost:8790`. Supabase remains the durable database. Daytona may be mocked for ordinary
development; a real account is required for snapshot, isolation, egress and teardown checks. GitHub
webhook testing needs a fresh tunnel URL because tunnel addresses are disposable.

The local worker entry point should exercise the same code that will run after deployment. Do not
add deployment-specific HTTP hops to the local path.

## Planned deployment

Vercel is the public, stateless tier. It receives authenticated GitHub, email and file-upload
intake, serves the reviewer UI, and hosts the authenticated `publish_verdict` MCP route. Supabase
Postgres stores reports, jobs, leases, sessions, approvals, immutable verdicts and delivery intent.

A Zerops project holds the persistent tier:

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

Each loop needs a distinct owner id, idle backoff, jitter and a fixed concurrency limit. On
`SIGTERM`, the process stops claiming new work and allows the lease protocol to recover anything it
cannot finish.

## First deployment gates

Do not describe the Zerops topology as live or production-ready until all of these pass:

1. A pending TrueForge session and approval survive a service restart and redeploy.
2. SQLite WAL behavior works on the mounted Local Storage volume.
3. `sqlite3 .backup` produces a restorable copy while the service is running.
4. Worker shutdown, restart and expired-lease recovery do not lose or duplicate work.
5. TrueForge and the worker have useful liveness and readiness checks.
6. Neither service has public access, private service names resolve only inside the project, and the
   TrueForge proxy rejects a request without the configured bearer token.
7. Resource ceilings and billing alerts are set before the services remain online.
8. One real report completes the Track A approval path through the deployed worker.

Start with one TrueForge replica and SQLite. Add Postgres and Valkey only for distributed TrueForge.
Oracle Always Free is an optional disposable experiment, not the deployment target. Its capacity
and allowance can change without changing this architecture.
