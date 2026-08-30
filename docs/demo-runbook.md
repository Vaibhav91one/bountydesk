# BountyDesk — Hackathon Demo Runbook

One page. Follow top to bottom on demo day.

---

## The one-line pitch
"Bug report comes in, our TrueForge agent investigates the target in an isolated sandbox using its own tools, drafts a verdict from what it found, and hands a human the exact text to approve before anything ships. No auto-close, ever."

---

## Happy path (the live demo)

**Target:** the connected fork `Vaibhav91one/juice-shop` at commit `1867b926c5f50e4e692dc9c8f61821413cebe0cd`, which is the `v17.3.0` tag and the same commit as upstream's, built into an immutable image and pinned by digest and snapshot ID.
**Vuln class:** SQLi (single request, deterministic), confirmed by the agent's own sandboxed investigation.

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
flow, not that run's canary pipeline.

1. **Intake** — a GitHub issue on the dedicated demo repo: `SQLi in /api/search`. The **installed BountyDesk GitHub App** delivers a **signed** webhook (`X-Hub-Signature-256`, platform-owned App secret); the receiver verifies it and resolves `installation_id → repo → TargetProfile` server-side → harness starts a TrueForge session.
2. **Triage** — scope_check passes, dedupe_check clean, PoC extracted. (Text-only, seconds.)
3. Investigate (the money moment): the driver's turn message tells the agent which target is authorized, with its pinned image, digest, and snapshot, and starts its turn. The agent investigates using its own TrueForge sandbox, scope-guard, skills, and subagents; it decides what to try, and none of it is scripted for it in advance. Say out loud: "the verdict is the agent's own conclusion, not something we handed it. Nothing reaches the reporter until a person reads that exact text and approves it, and a reproduced claim can't become a verdict in the first place unless the target's authorization already checked out, before a human ever saw the draft."
4. Draft: from what it found, the agent calls `publish_verdict` with its own outcome, summary, and findings, and the turn ends on that pending call.
5. Packet: the case file shows the agent's drafted outcome, summary, and findings, plus the evidence it gathered, with the researcher's raw PoC quarantined alongside in a labeled "unverified" box.
6. Human gate: `publish_verdict`'s pending call is what the reviewer sees (session persisted). Reviewer reads the agent's drafted findings, clicks **Allow** → a NEW approval turn carries `user.tool_approval` → one DB commit (verdict + outbox) → the delivery worker mints a **short-lived GitHub App installation token** server-side, posts the comment idempotently, and discards the token. Control is *not* pre-filled.
7. Kill-the-process flourish (optional): kill the harness at step 6, reopen browser, session still waiting. "State's in the DB, not memory."

---

## Backups — three layers, use in order

| # | Trigger | What you do |
|---|---------|-------------|
| **A** | Sandbox won't boot / reproduction can't run | Let it fall to the **analysis fallback**: the harness emits `could-not-deploy` and prepares an **evidence packet for human review**. It does not determine genuineness, assign severity, or publish a verdict. **Demo it as a feature:** "when reproduction can't run, a reviewer still gets grounded evidence." Not a crash — resilience. |
| **B** | Daytona cloud or venue network is down entirely | Narrate over the **pre-recorded run** (screen capture/GIF + the pre-generated Word packet). Hard floor, zero live dependency. |
| **C** | The primary scenario flakes but the sandbox is fine | Switch to **Scenario 2** (login bypass, frozen in decisions Q18) inside the same pinned target. Its recipe and two-step oracle are implemented, but this scenario has not run live yet, so treat it as a fallback narrated from the code and tests, not a second live-verified path. Never a second target. |

---

## Pre-warm checklist (do 30 min before — this prevents most live-demo deaths)

- [ ] Connected fork **built at the pinned commit** and the snapshot id recorded; Daytona sandbox **provisioned and warm**; target image **pre-pulled** (no cold-start on stage).
- [ ] **BountyDesk GitHub App** registered (Issues read/write + Metadata) and **installed on the one dedicated demo repo**. Subscribe to Issues + Repository events; handle the automatic Installation + Installation repositories events. Verify a signed test delivery, repository removal, suspension and uninstall; mint the approved-comment installation token server-side, post idempotently and discard it.
- [ ] The SQLi scenario on the pinned target **confirmed green** this morning: the agent investigates it and drafts `REPRODUCED`. Scenario 2 (login bypass) rehearsed from its tests if its live-run PR has landed by then.
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
