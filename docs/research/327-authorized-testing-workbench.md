# Research: Authorized testing workbenches for issue #327

How five pentest workbenches define engagement scope, enforce it technically,
require human approval, log for audit, and separate the testing workspace from
triage/reporting. Maps patterns onto BountyDesk so issue #327's proposal in
`docs/pentest-workbench.md` can reuse proven shapes.

## 1. How five current products handle scope and governance

### 1.1 Burp Suite Professional

Burp Professional is a GUI-first, per-seat desktop tool. Scope is a
user-authored URL-matching rule set in the Target tab: the tester enters
target hosts, ports, and URL prefixes, and Burp marks matching traffic as
"in scope." Scope gates the Scanner, Intruder, and the agentic Burp AT
extension, which refuse out-of-scope URLs. Scope is per-project file, not
server-side. Burp AT drafts payloads and attack plans but the human
initiates and reviews them. Burp Professional has no immutable audit trail
or egress proxy; it trusts the tester. It is the wrong fit for headless-in-mesh
because its MCP server runs as a Burp extension needing the GUI alive
[https://portswigger.net/burp/burp-at, https://github.com/portswigger/mcp-server].

### 1.2 Caido

Caido ships as a desktop app plus a headless CLI/Docker image. Scope is an
allowlist of domains and URL patterns in a JSON config or via the CLI
`--ui-domain` flag, enforced by a built-in domain allowlist that gates which
hosts the proxy and tools can reach
[https://docs.caido.io/app/guides/scopes_defining,
https://docs.caido.io/app/guides/domain_allowlist]. Caido's assistant is an
LLM feature, like Burp AT, operating on human approval rather than running
autonomously. Audit logging is a project backup/export. The relevant pattern
is the machine-readable allowlist every outbound path checks.

### 1.3 XBOW

XBOW is a fully autonomous pentester. Scope is locked at launch with no
runtime path for the agent to widen it. Enforcement is layered: a DNS-layer
egress proxy blocks out-of-scope lookups, an independent "Guardian" model
vetoes each agent action outside the solver's reasoning loop, and every action
lands in an immutable audit trail. Scope is an architectural boundary set
before launch, making escalation impossible rather than merely discouraged
[https://xbow.com/blog/autonomous-agent-safety-guardrails]. The separate
Guardian model and immutable audit trail are patterns BountyDesk could borrow.

### 1.4 Horizon3 NodeZero

NodeZero runs as a self-contained "agent pod" deployed into the customer's
environment. Scope is defined by a scan config that pins targets, credentials,
and tools. The pod is safe-by-default: it refuses to attack out-of-scope assets
and pauses when target health degrades. It validates every finding with a real
proof-of-exploit and re-tests after a fix, and its reporting is a separate UI
layer pulling from the pod's immutable run log [https://horizon3.ai/nodezero/].
The detailed enforcement mechanism was not in the public docs fetched; the
relevant transfer is the pod-as-execution-boundary and post-hoc validation loop.

### 1.5 Pentera

Pentera Platform runs automated internal/external/cloud pentesting. Scope is
set per-run through a target config that pins IPs, credentials, and toolsets.
Pentera is safe-by-default within configured targets, produces an
audit-proof log, and separates execution from validation and reporting
["controlled execution with audit proof",
https://pentera.io/pentera-platform/#compliance-list]. The technical mechanism
is not detailed in the marketing copy. Relevant transfer: execution-to-reporting
separation.

### 1.6 Strix (open source)

Strix is the closest open-source analogue: a multi-agent pentester running
tools in a Docker sandbox and validating findings with real PoCs. Its scope is
the target URL the operator points it at, and its "authorized use only" clause
is license-level, not technical [https://github.com/usestrix/strix]. Relevant
as a reference for a BountyDesk-owned image that bakes the tool stack, but it
has no egress proxy, no human approval gate, and no immutable audit trail.

## 2. Comparison

| Product | Scope | Enforcement | Human approval | Audit | Workspace |
|---|---|---|---|---|---|
| Burp Pro | URL allowlist in project file | Scanner/AT refuses out-of-scope | AT: human executes drafts | Project-file export | Per-project file |
| Caido | Domain/URL JSON config + CLI flag | Domain allowlist gates proxy/tools | AI assistant: human-initiated | Project backup/export | Per-instance file |
| XBOW | Scope locked at launch | DNS egress proxy + Guardian model | Guardian vets each action | Immutable audit trail | Agent pod boundary |
| NodeZero | Scan config pins targets/creds | Safe-by-default pod, no egress | Health auto-pause | Immutable run log | Pod vs. dashboard |
| Pentera | Target config pins IPs/creds | Controlled execution within scope | Safe-by-default posture | Audit-proof log | Execution vs. dashboard |
| Strix | Operator points at one URL | Docker sandbox | None automated | Container logs | Docker isolation |

Takeaway: autonomous agents (XBOW, NodeZero, Pentera) enforce scope through
architectural isolation (a pod or sandbox with no egress) rather than URL
allowlists alone. Human-driven tools (Burp, Caido) use a user-authored
allowlist gating tool output. BountyDesk already has sandbox isolation from
the browser-probe pattern, so the gap is the manifest pinning which in-mesh
peers the workbench may reach, and a Guardian check on destructive actions.

## 3. Fit with BountyDesk's existing code

The workbench reuses the browser-probe pattern almost verbatim. Every component
already exists; this section maps the design doc's phases to the files they
touch.

**Image** (new, forked from `sandbox-images/browser/Dockerfile`):
`FROM node:20-bookworm-slim`, install nuclei, httpx, newman, bake marker
`workbench-out-1` to `/etc/bountydesk-build-marker`,
`CMD ["sleep","infinity"]`. Same manual operator build/push/register flow as
the browser image (`docs/browser-probe.md`); only CI-built image is the
target (`.github/workflows/build-daytona-target.yml`).

**Sandbox creation** (`lib/sandbox/daytona.ts`): `createSandbox` (line 255)
hardcodes `networkBlockAll: true`; no caller can request network. The
workbench calls it with a `LinkSpec`, joining the target mesh as a linked,
ephemeral peer (`linkedSandbox` + `ephemeral`, line 289).
`assertSnapshotImage` (line 201) allows the tag override; `buildMarkerCheck`
(`lib/sandbox/build-marker.ts:33`) re-verifies identity from inside.

**Mesh join** (`lib/sandbox/provision.ts`): `provisionMesh` (line 749) boots
the app as parent, joins each peer via `createSandbox` with
`{ parentSandboxId }`, verifies no-egress + build-marker on every node, and
wires `/etc/hosts` so peers resolve by service name. The workbench joins
this same group.

**Scope enforcement** (`lib/scope-guard/`, `app/api/mcp/scope-guard/route.ts`):
already implements allow-list/deny-list matching (CIDR, hostname, wildcard),
hard-denies cloud-metadata and link-local (`lib/scope-guard/scope.ts` line
50). The workbench's in-sandbox MCP mirrors it: the agent calls `recon`/`
web_scan`/`sql_probe`, the guard checks requested host:port against a
server-authored manifest derived from `TargetProfile.scopeRules`
(`lib/targets/registry.ts` line 30) before dispatching the tool. The manifest
never comes from an agent string; it flows from the frozen `TargetProfile`
through `lib/targets/configure.ts`'s `upsertTargetProfile` into the sandbox
at boot.

**Probe surface** (`lib/mcp/probe-target.ts`): `probe_target` (GET/HEAD,
line 62) and `probe_target_write` (POST, line 67) are the template. Same-origin
path resolution, capability-bound session lookup, `hasActiveRepositoryGrant`
re-check (`lib/targets/repository-grant.ts`), and `resolveTargetUrl` origin
check (line 78) — copied so an agent cannot slip a cross-origin URL.

**Human approval gate** (`app/api/mcp/publish-verdict/route.ts`,
`lib/agent-sessions/poller.ts`): `publish_verdict` is the only approval-gated
tool, content-hash locked (route.ts line 31, poller's
`draftVerdictFromPendingCall`, poller.ts line 679). Tool calls inside the
no-egress sandbox are auto-approved (`autoApproveWriteProbe`, poller.ts line
491) because the only network a write probe reaches is the isolated mesh. Raw
tool output never leaves the sandbox; the agent uses it as evidence, drafts a
verdict, and a human approves before delivery.

**Data model** (`drizzle/` migrations): `target_profile` already holds
`scope_rules` (`registry.ts` line 30), `image_name`, `image_digest`, and
`config`. A workbench profile adds only a new `image_name`/`image_digest` pair
and a build-marker constant; no new table is needed for Phase 0.

## 4. Risks and open questions

- **Scope-manifest correctness** is the load-bearing risk. A mis-scoped mesh
  is the only leak path. The manifest must be server-authored, tested, and
  re-checked before every tool exec, not mitigated by XBOW's DNS proxy.

- **Non-determinism.** Active scans yield different findings run-to-run,
  fighting BountyDesk's deterministic oracle. The proposal accepts this as
  evidence-only (scan hit is a lead; `lib/reproduction/decide.ts` stays the
  sole gate for `REPRODUCED`, `docs/pentest-workbench.md` line 108-112), but
  how much the agent should trust a non-proven finding is open.

- **Image size and cost.** Phase 0 stays slim (nuclei, httpx, newman), but
  Phase 2 adds ZAP, sqlmap, dalfox, bloating the image and cold-start. No
  public Daytona cost model cited; needs a benchmark.

- **Tool licensing.** Burp Professional is excluded (per-seat GUI, no headless
  CI); ZAP, nuclei, newman are Apache-2.0/MIT. NodeZero, Pentera, XBOW are
  commercial and not embeddable.

- **Target health.** Detecting degradation inside a no-egress mesh is open:
  no internet to poll liveness, only the sandbox exec result as a signal.

- **Audit trail.** XBOW logs every action immutably; BountyDesk's scope-guard
  logs to Postgres (`lib/scope-guard/audit.ts`) but not every agent tool call
  against the target. Whether to add an immutable action log is open.

- **No egress vs. scope allowlist.** BountyDesk's `networkBlockAll: true`
  plus `verifyNoEgress` is stronger than XBOW's DNS proxy (no egress path to
  block), but BountyDesk pins the target at bind time, so the workbench cannot
  scan a service discovered after boot.
