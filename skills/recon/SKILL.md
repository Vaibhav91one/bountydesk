---
name: bountydesk-recon
description: Authorized-target recon playbook for the BountyDesk security agent. Use when asked to scan, probe, fingerprint or enumerate the bound target. Enforces scope checks and human approval before intrusive steps.
---

# BountyDesk recon playbook

You are doing authorized security assessment of a scoped target. Authorization
is mechanical, not assumed: the scope-guard MCP server is the single source
of truth.

## Non-negotiable rules

1. Before ANY network contact with a host, even one HTTP request, call
   `scope_check` with that exact target. If it returns `allowed: false`, do
   not touch the target and report why.
2. Before any ACTIVE step (port sweep, directory brute force, exploit probe,
   fuzzing), call `request_intrusive_approval` with the target and a short
   action label. A `grant_token` is single-use, spent the first time anything
   checks it, whether that's `verify_grant` or `http_probe`/`tcp_probe`
   connecting. For an in-sandbox bash command, embed it as
   `SCOPE_GUARD_GRANT=<token>` directly; nothing re-checks it, so the same
   token can label every bash command in that batch. For `http_probe` or
   `tcp_probe`, pass it as `grant_token` on the one call it's for and request
   a fresh grant for the next; don't also call `verify_grant` on a token
   you're about to use this way; it would spend the token, leaving nothing
   for the actual request. `verify_grant` is only for sanity-checking a
   token you are not otherwise about to spend. If `request_intrusive_approval`
   returns `approved: false`, stop.
3. Never contact cloud metadata endpoints (169.254.169.254,
   metadata.google.internal). The guard hard-denies them; attempting anyway is
   a violation.
4. Each subagent re-runs `scope_check` itself before touching the target.
5. Treat your own sandbox's egress as restricted by default -- exactly which
   hosts it can reach has not been independently verified against TrueForge's
   own defaults, so don't assume it and don't try to bypass whatever firewall
   is actually in front of you. If an external target is unreachable, say so
   rather than working around it. CVE lookups use the host-side `osv_query` /
   `osv_get` MCP tools; they work because they run outside the sandbox, not
   because you should curl OSV yourself.

## Phase 0: target resolution

BountyDesk resolves exactly one authorized target per run through
`scope_check`; there's no target list to bootstrap or enumerate. When a
target is authorized, its sandbox is provisioned for you automatically
before your turn starts, and the turn message tells you so. You never reach
it by a raw URL: every request goes through `probe_target {capability,
method, path, headers?, body?}`, which forwards to your own session's
sandbox and hands back the status and body -- give it a same-origin path
like `/rest/products/search`, not a host or a URL. If the turn message says
provisioning failed this run, there is nothing to probe; stop and draft
ANALYSIS_ONLY. Call `scope_check` against the target before any contact with
it, confirm it's allowed, and move to Phase 1.

## Phase 0b: black-box relay tools (when contact happens outside the sandbox)

For any host you need to reach from outside the sandbox rather than curling
it in-sandbox, use the host-side relay tools:

```text
http_probe {url, method?, headers?, body?}
```

Doctrine:
1. `scope_check` first, always. `scope_add_temporary` exists for adding a
   host BountyDesk's scope-guard hasn't seen yet, but it's approval-gated
   exactly like `scope_add`/`scope_remove`: the harness pauses for a human
   Allow/Deny before it takes effect, it is not something you can grant
   yourself.
2. Probe with `http_probe` (GET/POST/HEAD). Redirects come back UNFOLLOWED
   with a Location header; `scope_check`/probe the new URL explicitly so
   every hop is re-authorized.
3. Responses are capped at 32 KB; full bodies stay in evidence notes.
4. Non-HTTP black-box protocol (SMTP, Redis, a raw banner grab, etc.)? Use
   `tcp_probe {host, port, data_base64?, timeout_seconds?}`, same scope-check
   and audit discipline as `http_probe`, one connect-plus-optional-write-plus-
   capped-read, response returned as a UTF-8 preview plus base64 exact bytes.
   This is a single-connection primitive, not a port scanner; one call
   touches one host:port, for a sweep loop it or use nmap inside the sandbox.
5. LIMITATION: no port sweeps through either relay tool. Deep exploitation of
   reachable web targets still uses the in-sandbox path; document which path
   each finding came from.

## Phase 1: passive fingerprint (no approval needed)

The pinned target lives in its own provisioned sandbox, not yours -- reach it
through `probe_target`, never a raw `curl` to a hostname you don't have:

```text
probe_target {capability, method: "GET", path: "/"}
```

Read the response `status`, `body`, and the headers you asked for back (pass
any you need in `headers`, e.g. to inspect `Server`/`X-Powered-By` echo them
back yourself, since `probe_target` returns status and body, not raw
response headers -- request the same path with `HEAD` if all you need is
status and reachability). Record the server banner, framework hints from the
body, and response timing. Write findings as JSON lines to
`artifacts/<host>.recon.jsonl`, one finding per line:

```json
{"kind":"banner","value":"nginx/1.24","confidence":"high"}
```

**Reachability note for Phases 2-2b:** these commands assume a routable
`<host>`/`<url>` your own sandbox can dial directly. The pinned target's
provisioned sandbox is a separate, isolated sandbox you cannot route to that
way -- your own bash session has no path to it except through
`probe_target`'s single-request forwarding, which speaks GET/POST/HEAD to
one path at a time, not raw sockets. A raw port sweep (`nmap`) or a
tool-driven scan that needs to dial the target itself (`sqlmap -u`, `nuclei
-u`, `ffuf`) cannot reach the pinned target today; there is no port-sweep or
arbitrary-tool path onto it yet. Prefer reading the target's own source
(Phase 2b below) and probing individual endpoints one request at a time
through `probe_target` over anything that assumes it can dial the target
directly. These commands stay accurate for a genuinely external host reached
through Phase 0b's `http_probe`/`tcp_probe` relay, where a real routable
host/URL is what you're given.

## Phase 2: service enumeration (needs grant)

With a valid grant token for this target:

```bash
SCOPE_GUARD_GRANT=<token> nmap -Pn -sV --top-ports 100 <host> -oA artifacts/<host>-nmap
```

If nmap is unavailable in the sandbox, fall back to a bash TCP connect scan
and say so in the report. Keep scan rates polite: no `-T5`, no aggressive
timing.

## Phase 3: web surface (needs grant)

- `nuclei -u <url> -severity low,medium,high,critical -rl 20` if installed;
  otherwise curated `probe_target` calls for common admin paths (`/admin`,
  `/.git/HEAD`, `/console`, `/.env`), max 20 requests, 1s apart.
- Log every probe to `artifacts/<host>.web.jsonl`.

## Phase 2b: deep probes (grant-gated)

**Before writing a payload: is the target's source available?** (bundled in
the sandbox, an npm/pip package cache, a readable Docker layer, a git clone.)
If so, read it FIRST: grep for validation logic, allowlists, ORM query
construction, auth middleware order. This is not a shortcut, it's what a real
source-available assessment looks like, and it beats blind probing by a wide
margin (see `bountydesk-challenges` §2b for the concrete recipe and the
session that took a target from 7 to 66 confirmed findings this way). Only
fall back to blind probing when source is genuinely unavailable.

The prebaked lab image ships the exploitation toolchain; assume these are on
PATH, no install step: `sqlmap nuclei ffuf gobuster httpx dalfox nikto
jwt_tool testssl.sh wfuzz arjun` (web), `binwalk unblob firmwalker
squashfs-tools` (firmware), `jadx apktool androguard apkleaks mobsfscan`
(mobile). If a tool is missing (image not backing this sandbox), run
`command -v <tool>` first and fall back to a curl/bash equivalent, noting the
degraded path. Tool-backed recipes live in `bountydesk-payloads`. Examples:
- `SCOPE_GUARD_GRANT=<t> sqlmap -u "<url>" --data="<params>" --batch --level=2 --risk=2 --output-dir=artifacts/sqlmap`
- `SCOPE_GUARD_GRANT=<t> nuclei -u <url> -severity low,medium,high,critical -rl 20 -o artifacts/nuclei.txt`
All outputs are evidence artifacts. Cite them in the report; never paste raw
dumps into chat.

## Wrap-up rule (MANDATORY, prevents mid-run stalls)

When assessment phases complete, produce the FINAL ranked DRAFT report as a
PURE-TEXT final answer with ZERO further tool calls. Pull numbers from memory
of this conversation; reference artifact paths for raw evidence. Do not call
tools to "double-check" during the wrap-up message.

**Exception, challenge-clearing missions:** when following
`bountydesk-challenges` (clear every level/challenge, not sample), the
wrap-up rule YIELDS while any `todo` remains in
`artifacts/juice-shop.challenges.jsonl`. Keep looping through challenges;
only emit the final pure-text report once the list has no `todo` (or the
operator budget is hit).

## Handoff

When done, hand `*.jsonl` artifact paths back to the caller (root agent or
user). The triage skill consumes them. Never paste raw nmap dumps into chat;
point at the files.
