---
name: bountydesk-challenges
description: Systematic challenge/level clearing for deliberately-vulnerable lab apps (DVWA, Juice Shop, WebGoat, VAmPI, DSVW) and multi-level targets. Use when the goal is to CLEAR as many of a target's challenges/levels as possible rather than sample a few vuln classes. Enumerates the app's own challenge set, tracks per-challenge progress in an artifact that survives grant/wrap-up boundaries, and loops until exhausted.
---

# BountyDesk challenge-clearing playbook

Default recon (`bountydesk-recon`) SAMPLES vuln classes: confirm-or-deny a
representative few, then stop. This skill is the opposite mode: enumerate a
lab app's FULL challenge/level set and work each item to evidence-grade proof,
tracking progress so a run resumes instead of one-shotting. Use it only for
deliberately-vulnerable labs the operator owns (loopback targets).

Everything in `bountydesk-recon` still applies: `scope_check` first, grants
before active steps, artifacts for all evidence, the 5-check validation gate
per confirmed challenge. This skill adds enumeration, progress state, and the
loop.

## 1. Get a grant per batch

BountyDesk's scope-guard mints a single-use, target-bound grant per
`request_intrusive_approval` call, always paused for a human Allow/Deny first;
there is no autonomous multi-use lab mode. Request a fresh grant for each
batch of work and embed it as `SCOPE_GUARD_GRANT=<token>` in every in-sandbox
bash command of that batch (nothing re-checks it there, so one token can
label a whole batch). If a step in the batch goes through `http_probe` or
`tcp_probe` instead, that call spends the grant at connect time; request
another for the next one. Don't call `verify_grant` on a token you're about
to spend this way, since `verify_grant` itself consumes it.

## 2. Enumerate the app's OWN challenge set (don't hand-maintain lists)

Most lab apps expose their challenge/level taxonomy; pull it at runtime.
Every `GET`/`POST` path below is a `probe_target` call
(`probe_target {capability, method, path, ...}`), not a raw request to a
host you can dial yourself -- the pinned target lives in its own provisioned
sandbox, reachable only through that tool. Read `bountydesk-recon`'s Phase 0
and 1 before this section if you haven't already:

- Juice Shop: `GET /api/Challenges/` returns JSON of every challenge (name,
  category, `solved`). This IS the scoreboard and the progress signal, and is
  the app BountyDesk's pinned target (`Vaibhav91one/juice-shop`) runs today.
- WebGoat: `GET /service/lessonmenu.mvc` (authenticated) lists lessons and
  completion; `/WebGoat/service/lessonoverview.mvc` per-lesson assignments.
- DVWA: modules are fixed (Brute Force, Command Injection, CSRF, File
  Inclusion, File Upload, Insecure CAPTCHA, SQLi, Blind SQLi, Weak Session IDs,
  XSS DOM/Reflected/Stored, CSP Bypass, JavaScript, Open HTTP Redirect). Each
  runs at 4 levels via the `security` cookie (`low|medium|high|impossible`).
  The matrix is modules times levels.
- VAmPI: finite documented set (SQLi on users, mass assignment, hardcoded
  JWT secret, IDOR/BOLA, unauth `/createdb` and `/users/v1/_debug`, excessive
  data exposure, user enumeration, ReDoS).
- DSVW: about 17 endpoints, each a distinct vuln (`?id=` SQLi bool/union/
  time, `?query=` XSS, `?path=` traversal/RFI, `?xml=` XXE, `?name=` XPath,
  `?url=` SSRF, `?size=` DoS, unsafe pickle, SSTI). Enumerate from the landing
  page.

For anything else: crawl (`gobuster`/`ffuf` plus `httpx`) and treat each
distinct sink as a challenge.

## 2b. Read the target's own source before blind-probing (highest-leverage step in this whole skill)

DVWA, Juice Shop, VAmPI, and DSVW are all open-source and typically bundled
inside the running container/sandbox. **When source is available, read it
before writing a single payload.** This is not cheating, it's what a real
source-available assessment looks like, and it is dramatically faster than
trial-and-error probing. One session's Juice Shop run went from 7 confirmed
challenges to 66 the moment it stopped guessing and started reading the
server's own solve-condition hooks:

```bash
# Juice Shop: every challenge's exact trigger condition, verbatim, in source
grep -rn "challengeUtils.solveIf\|challengeUtils.solve(" routes/ lib/ models/
# any Express/Flask/Rails/etc target: read the route/controller source
# directly for validation logic, allowlists, auth middleware order, and the
# exact sink (e.g. an ORM query built with string concatenation confirms
# SQLi without needing to fuzz for it)
```

Only fall back to blind probing (fuzzing, payload spraying) when source is
genuinely unavailable: a real black-box target, a compiled binary, or a
container that doesn't expose its own code. When it IS available, treat
"decompile/read source" as the mandatory first move of Phase 2b in
`bountydesk-recon`, not an optional shortcut.

## 3. Seed the progress artifact

Write one JSON line per challenge to `artifacts/juice-shop.challenges.jsonl`
(name the pinned target explicitly rather than a generic `<host>` placeholder,
since BountyDesk resolves exactly one authorized target). This file is the
mission's memory: it survives grant expiry and the wrap-up rule, and a resumed
subagent reads it to skip finished work:

```json
{"id":"juiceshop/scoreDcp/loginAdmin","class":"sqli","level":"n/a","status":"todo"}
{"id":"juiceshop/xss/domXss","class":"xss","level":"n/a","status":"todo"}
```

`status` is one of `todo`, `confirmed`, `blocked`, `not-applicable`. On
resume, re-read the file and only work `todo` items.

## 4. Work each challenge, then update its line

Per challenge: pick the tool-backed recipe (`bountydesk-payloads`), run it
with the grant, capture raw evidence to `artifacts/<id>.<ext>`, apply the
5-check gate (`bountydesk-validation`), then rewrite that challenge's line:

```json
{"id":"juiceshop/scoreDcp/loginAdmin","class":"sqli","level":"n/a","status":"confirmed",
 "evidence_ref":"artifacts/juiceshop-scoreDcp-loginAdmin.txt","because":"union dump of users table"}
```

For the app's own scoreboard (Juice Shop), re-`GET /api/Challenges/` after
each exploit to confirm `solved:true`, that's ground truth, better than
self-report.

## 5. Honest ceiling: mark, don't force

Some challenges are infeasible for an autonomous CLI agent. Mark them
`blocked` with a one-line reason and move on, never fake a solve:

- Crypto/hash-cracking with real work factor, timing side-channels.
- Challenges requiring external services, email, or real payment.
- CSP/interaction challenges needing a real user to click a live victim page.
- Mobile **dynamic** (Frida/objection) without a device/emulator.

DOM XSS is NOT auto-blocked: the image prebakes headless `chromium` (verified
working: a `location.hash` to `innerHTML` sink payload executed and mutated
`document.title`, captured correctly in the dumped DOM). Prefer a payload
that MUTATES something observable post-load (title, a new attribute, an
appended node) over a bare `alert()`, headless has no dialog to catch, but a
DOM mutation shows up in `--dump-dom` unambiguously:

```bash
chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --dump-dom \
  "<url>#<img src=x onerror=document.title='BOUNTYDESK_MARKER'>" > artifacts/<id>.dom.html
grep -q BOUNTYDESK_MARKER artifacts/<id>.dom.html && echo CONFIRMED
```
`--disable-dev-shm-usage` avoids a crash on the sandbox's small `/dev/shm`.
This one needs a real `<url>` a browser can navigate to, which is exactly
what `probe_target`'s single-request forwarding doesn't give you -- your own
sandbox has no direct route to the pinned target the way this recipe
assumes. Mark a DOM XSS challenge `blocked` with that reason rather than
guessing at a URL, unless the run's own turn message hands you a real,
directly reachable target origin.
Stderr `dbus`/`NameHasOwner` lines are harmless noise (no session bus in a
minimal container), not a failure signal, ignore them.

## 6. Loop, then wrap up

Repeat step 4 until `challenges.jsonl` has no `todo` (or the operator's budget
is hit). ONLY THEN produce the final ranked DRAFT report as pure text; the
`bountydesk-recon` wrap-up rule yields to this loop while any `todo` remains.
Report coverage as `confirmed / blocked / total` per class, and cite the
progress artifact.
