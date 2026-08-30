# BountyDesk: hackathon demo runbook

Follow top to bottom on demo day.

---

## The one-line pitch
"Bug report comes in, our TrueForge agent investigates the target in an isolated sandbox using its own tools, drafts a verdict from what it found, and hands a human the exact text to approve before anything ships. No auto-close, ever."

---

## Happy path (the live demo)

**Target:** the connected fork `Vaibhav91one/juice-shop` at commit `1867b926c5f50e4e692dc9c8f61821413cebe0cd`, which is the `v17.3.0` tag and the same commit as upstream's, built into an immutable image and pinned by digest and snapshot ID.
**Vuln class:** SQLi (single request, deterministic). The live proof on record is the deterministic canary pipeline, not the current agent-authored path.

**Confirmed live 2026-08-29,** under the deterministic canary pipeline that predated the
2026-08-30 agent-authored-verdict redesign (`docs/decisions.md` Q22). That run went end to end
against a real GitHub issue
([Vaibhav91one/juice-shop#5](https://github.com/Vaibhav91one/juice-shop/issues/5)): report
`beabb524-1bd7-4651-a9b8-2363926b0a49`, verdict `7cbf3647-2b32-4582-9d43-9db49509aa4d`,
outcome `REPRODUCED`, delivered as
[comment 5464633799](https://github.com/Vaibhav91one/juice-shop/issues/5#issuecomment-5464633799)
whose body matched the approved content hash exactly. Replaying the same webhook delivery
afterward produced no second job, report, or comment. The approval gate and the delivery
idempotency it proved still work the same way; the steps below describe today's agent-driven
flow, not that run's canary pipeline. Unless a newer run has concrete evidence attached to it,
do not say the agent-authored TrueForge path has been live-proven.

---

## Operator run sequence

Run these in order on the demo machine. Keep each long-running process in its own terminal.

1. Prepare the local environment and database.

   ```bash
   cp env.example .env.local
   # Fill .env.local with the real DATABASE_URL, DIRECT_URL, GitHub App,
   # TrueForge, scope-guard, Daytona and target pinning values.
   npm install
   npm run db:migrate
   ```

2. Start the app on the origin in `APP_BASE_URL`.

   ```bash
   npm run dev
   ```

3. Expose the local app to GitHub and update both `.env.local` and the GitHub App settings.

   ```bash
   cloudflared tunnel --url http://localhost:3000
   # or: ngrok http 3000
   ```

   Set `GITHUB_WEBHOOK_BASE_URL` to the HTTPS tunnel origin, then set the GitHub App webhook
   URL to `${GITHUB_WEBHOOK_BASE_URL}/api/intake/github`. Keep the callback URL at
   `${APP_BASE_URL}/api/auth/github/callback` and the setup URL at
   `${APP_BASE_URL}/api/github/setup`.

4. Start TrueForge locally, on loopback only.

   ```bash
   npx @truefoundry/trueforge@latest
   ```

   The repo expects `TRUEFORGE_URL=http://localhost:8790`. Local TrueForge mode has no login by
   default, so do not put it on a public tunnel.

5. Register the BountyDesk skills, MCP connectors and saved agent with that TrueForge instance.

   ```bash
   npm run skills:apply
   npm run agent:apply
   ```

6. Bind the connected demo repository to the pinned target. The repository id for
   `Vaibhav91one/juice-shop` is `1347703889`.

   ```bash
   npm run seed:target -- 1347703889
   ```

   After a verified rebuild only, rotate the existing target instead of reseeding it.

   ```bash
   npm run rotate:target -- 1347703889
   ```

7. Start the durable worker loops.

   ```bash
   npm run worker:daemon
   ```

8. Create the report issue.

   ```bash
   cat >/tmp/bountydesk-sqli-issue.md <<'EOF'
   The search endpoint appears injectable.

   Steps:
   1. Open /rest/products/search?q=apple
   2. Send q=qwert')) UNION SELECT id,email,password,'4','5','6','7','8','9' FROM Users--
   3. The response includes user rows.

   Expected: user records are not returned from product search.
   EOF

   gh issue create \
     --repo Vaibhav91one/juice-shop \
     --title "SQLi in /rest/products/search" \
     --body-file /tmp/bountydesk-sqli-issue.md
   ```

9. Approve only from the app. Open the board, sign in with an allowlisted GitHub account,
   open the new case file, read the agent draft, then click Allow.

   ```bash
   open http://localhost:3000/board
   ```

10. Check delivery and replay idempotency. First capture the issue number and delivery id.
    The delivery id is visible in the GitHub App delivery log for the issue webhook.

   ```bash
   ISSUE=<issue-number>
   DELIVERY=<x-github-delivery>
   REPO_ID=1347703889

   psql "$DIRECT_URL" -c \
     "select delivery_id, state, report_id from inbound_job where channel = 'github' and delivery_id = '$DELIVERY';"

   psql "$DIRECT_URL" -c \
     "select id, state from report where source_ref = 'github:$REPO_ID:issue:$ISSUE';"

   gh api "repos/Vaibhav91one/juice-shop/issues/$ISSUE/comments" \
     --jq '[.[] | select(.body | contains("<!-- bountydesk-delivery:"))] | {count: length, ids: map(.id)}'
   ```

   Redeliver the same issue webhook from the GitHub App delivery log, then rerun the checks
   above. The expected result is one `inbound_job` row for the delivery id, one report for the
   source ref, and one BountyDesk delivery marker in the issue comments.

## Talk track

1. **Intake** — a GitHub issue on the dedicated demo repo: `SQLi in /rest/products/search`. The **installed BountyDesk GitHub App** delivers a **signed** webhook (`X-Hub-Signature-256`, platform-owned App secret); the receiver verifies it and resolves `installation_id → repo → TargetProfile` server-side → harness starts a TrueForge session.
2. **Triage** — scope_check passes, dedupe_check clean, PoC extracted. (Text-only, seconds.)
3. Investigate (the money moment): the driver's turn message tells the agent which target is authorized, with its pinned image, digest, and snapshot, and starts its turn. The agent investigates using its own TrueForge sandbox, scope-guard, skills, and subagents; it decides what to try, and none of it is scripted for it in advance. Say out loud: "the verdict is the agent's own conclusion, not something we handed it. Nothing reaches the reporter until a person reads that exact text and approves it, and a reproduced claim can't become a verdict in the first place unless the target's authorization already checked out, before a human ever saw the draft." Also say plainly: "the August 29 SQLi proof used the deterministic canary runner. This agent-authored path is current code, but it still needs its own live proof."
4. Draft: from what it found, the agent calls `publish_verdict` with its own outcome, summary, and findings, and the turn ends on that pending call.
5. Packet: the case file shows the agent's drafted outcome, summary, and findings, plus the evidence it gathered, with the researcher's raw PoC quarantined alongside in a labeled "unverified" box.
6. Human gate: `publish_verdict`'s pending call is what the reviewer sees on the case file in `/board` (session persisted). Reviewer reads the agent's drafted findings, clicks **Allow** → a NEW approval turn carries `user.tool_approval` → one DB commit (verdict + outbox) → the delivery worker mints a **short-lived GitHub App installation token** server-side, posts the comment idempotently, and discards the token. Control is *not* pre-filled.
7. Kill-the-process flourish (optional): kill the harness at step 6, reopen browser, session still waiting. "State's in the DB, not memory."

---

## Backups — three layers, use in order

| # | Trigger | What you do |
|---|---------|-------------|
| **A** | Sandbox won't boot / reproduction can't run | Let it fall to the **analysis fallback**: the harness emits `could-not-deploy` and prepares an **evidence packet for human review**. It does not determine genuineness, assign severity, or publish a verdict. **Demo it as a feature:** "when reproduction can't run, a reviewer still gets grounded evidence." Not a crash — resilience. |
| **B** | Daytona cloud or venue network is down entirely | Narrate over the **pre-recorded run** (screen capture/GIF + the pre-generated Word packet). Hard floor, zero live dependency. |
| **C** | The primary scenario flakes but the sandbox is fine | Switch to **Scenario 2** (login bypass, frozen in decisions Q18) inside the same pinned target. Its recipe and two-step oracle are implemented in current code, but this scenario has not run live yet, so treat it as a fallback narrated from the code and tests, not a second live-verified path. Never a second target. |

---

## Pre-warm checklist (do 30 min before — this prevents most live-demo deaths)

- [ ] Connected fork **built at the pinned commit** and the snapshot id recorded; Daytona sandbox **provisioned and warm**; target image **pre-pulled** (no cold-start on stage).
- [ ] **BountyDesk GitHub App** registered (Issues read/write + Metadata) and **installed on the one dedicated demo repo**. Subscribe to Issues + Repository events; handle the automatic Installation + Installation repositories events. Verify a signed test delivery, repository removal, suspension and uninstall; mint the approved-comment installation token server-side, post idempotently and discard it.
- [ ] The SQLi scenario has a fresh evidence-backed dry run on the current agent-authored path, or the demo script explicitly says that path is still unproven. Scenario 2 (login bypass) rehearsed from its merged tests unless a separate live run has evidence.
- [ ] One **full happy-path dry run** end to end, today, on the demo machine + demo network.
- [ ] **Pre-recorded run** (Backup B) saved locally and openable offline.
- [ ] Pre-generated **Word packet** from a known-good run saved locally.
- [ ] GitHub issue draft ready to paste (don't type it live).
- [ ] Figma board open to the flow page; **UML page cleaned** (no movie-schema junk).
- [ ] Threat-model page shows the honest line: *demo on Daytona cloud; production = Kata microVM + host-side egress deny.* Rehearse the one-sentence version.

---

## If a judge asks the sharp questions

- "Isn't the verdict forgeable?" → "The agent draws its own conclusion from its own sandboxed investigation, but a reproduced or not-reproduced claim can't even become a verdict unless the target is authorized and its grant is still active. That check runs the moment the draft is persisted, before a human ever sees it, and nothing reaches the reporter until a person separately reads the exact text and approves it."
- "Is that sandbox actually safe for malicious code?" → "For the demo it's Daytona cloud, a shared-kernel container, fine for benign inputs. Production runs a Kata microVM with host-side egress default-deny and metadata blocked. It's on the threat-model page as a known upgrade."
- "Can this dedupe / auto-reject real bugs?" → "Two different things. A repeated webhook delivery is a safe automatic no-op. A *semantically* similar report is never auto-closed: we surface top-k candidates and a human decides. Same as HackerOne and Bugcrowd."
- "What about prompt injection in the report?" → "Report is treated as data, so nothing in it can pick a target or skip authorization. The agent's draft still needs a human to read and approve the exact text before anything ships. The board's threat-model page walks the attack chains."

---

## Do NOT demo / do NOT claim
- Don't claim production-grade sandbox isolation on Daytona cloud — say it's the demo layer.
- Don't call the agent's draft a verdict before a human approves it. The approval is what makes it one.
- Don't type anything live you can paste.
- Don't run the dynamic clone-and-build tier live unless the provisioning spike and a full rehearsal both went green today, on this network. This is a demo-risk decision, not a scope limit: the tier is designed and documented, and on stage it is a walkthrough of the two-sandbox diagram. The build is the one step that needs the network the rest of the demo brags about not having, and that is not a sentence to improvise.
- Don't demo email or file-upload intake as live. They are designed channels; show the UI and say so.
- Don't clone or install anything at runtime on stage. The target image is built and verified ahead of time; that's the point.
- Don't present DVWA, WebGoat or CVE lab work as report-shaped live targets. PR #55 added demo skills for self-booting teaching targets inside the agent's sandbox; they are for practice and demonstrations, not bound BountyDesk reports backed by a `TargetProfile`.
