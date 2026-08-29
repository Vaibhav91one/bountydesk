# BountyDesk — Hackathon Demo Runbook

One page. Follow top to bottom on demo day.

---

## The one-line pitch
"Bug report comes in, our harness deploys the target, reproduces the exploit in an isolated sandbox, and hands a human a documented evidence packet with a verdict — the human approves, the verdict ships. No auto-close, ever."

---

## Happy path (the live demo)

**Target:** the connected fork `Vaibhav91one/juice-shop` at commit `1867b926c5f50e4e692dc9c8f61821413cebe0cd`, which is the `v17.3.0` tag and the same commit as upstream's, built into an immutable image and pinned by digest and snapshot ID.
**Vuln class:** SQLi (single request, deterministic), confirmed by a **per-run canary**.

**Confirmed live 2026-08-29.** This exact flow ran end to end against a real GitHub issue
([Vaibhav91one/juice-shop#5](https://github.com/Vaibhav91one/juice-shop/issues/5)): report
`beabb524-1bd7-4651-a9b8-2363926b0a49`, verdict `7cbf3647-2b32-4582-9d43-9db49509aa4d`,
outcome `REPRODUCED`, delivered as
[comment 5464633799](https://github.com/Vaibhav91one/juice-shop/issues/5#issuecomment-5464633799)
whose body matches the approved content hash exactly. Replaying the same webhook delivery
afterward produced no second job, report, or comment. The steps below are what actually
happened, not a projection.

1. **Intake** — a GitHub issue on the dedicated demo repo: `SQLi in /api/search`. The **installed BountyDesk GitHub App** delivers a **signed** webhook (`X-Hub-Signature-256`, platform-owned App secret); the receiver verifies it and resolves `installation_id → repo → TargetProfile` server-side → harness starts a TrueForge session.
2. **Triage** — scope_check passes, dedupe_check clean, PoC extracted. (Text-only, seconds.)
3. Sandbox: boot the prebuilt pinned image. No clone, no install, no network at reproduction time: the sandbox is offline. The build that produced it ran earlier, and that is the only step that ever needed the network.
4. **Seed canary** — the trusted fixture seeds a fresh, unpredictable canary into the target. Run the **negative control** first: without the exploit, the oracle must not trip. The canary is *ours*, not the attacker's.
5. **Run PoC** — execute the submitted PoC against sandbox-localhost.
6. **Oracle (the money moment)** — the oracle runs **outside the PoC environment** and checks whether this run's canary reached the trusted sink. It did → `REPRODUCED`. Say out loud: **"the verdict comes from our canary, evaluated outside the sandbox — not from the PoC's own output. A researcher can't fake a 'reproduced.'"**
7. **Packet** — Word doc auto-generated: action-log flow (booted pinned image → seeded canary → negative control passed → ran PoC → oracle observed the canary @ timestamp) + *our* screenshot of the leaked canary + the researcher's raw PoC quarantined in a labeled "unverified" box.
8. **Human gate** — `publish_verdict` is called and the turn ends on a PENDING tool call (session persisted). Reviewer reads raw evidence, clicks **Allow** → a NEW approval turn carries `user.tool_approval` → one DB commit (verdict + outbox) → the delivery worker mints a **short-lived GitHub App installation token** server-side, posts the comment idempotently, and discards the token. Control is *not* pre-filled.
9. **Kill-the-process flourish** (optional) — kill the harness at step 8, reopen browser, session still waiting. "State's in the DB, not memory."

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
- [ ] The SQLi scenario on the pinned target **confirmed green** this morning; canary seed + negative control verified. Scenario 2 (login bypass) rehearsed from its tests if its live-run PR has landed by then.
- [ ] One **full happy-path dry run** end to end, today, on the demo machine + demo network.
- [ ] **Pre-recorded run** (Backup B) saved locally and openable offline.
- [ ] Pre-generated **Word packet** from a known-good run saved locally.
- [ ] GitHub issue draft ready to paste (don't type it live).
- [ ] Figma board open to the flow page; **UML page cleaned** (no movie-schema junk).
- [ ] Threat-model page shows the honest line: *demo on Daytona cloud; production = Kata microVM + host-side egress deny.* Rehearse the one-sentence version.

---

## If a judge asks the sharp questions

- **"Isn't the verdict forgeable?"** → "No. It's a fresh canary we seed through a trusted fixture, and the oracle runs outside the PoC's environment. We run a negative control first. The attacker controls the PoC and its output; they don't control our canary or our instrument."
- **"Is that sandbox actually safe for malicious code?"** → "For the demo it's Daytona cloud, a shared-kernel container — fine for benign inputs. Production runs a Kata microVM with host-side egress default-deny and metadata blocked. It's on the threat-model page as a known upgrade."
- **"Can this dedupe / auto-reject real bugs?"** → "Two different things. A repeated webhook delivery is a safe automatic no-op. A *semantically* similar report is never auto-closed — we surface top-k candidates and a human decides. Same as HackerOne and Bugcrowd."
- **"What about prompt injection in the report?"** → "Report is treated as data, and the verdict is a deterministic canary check outside the model — plus a human gate that can't be skipped. The board's threat-model page walks the attack chains."

---

## Do NOT demo / do NOT claim
- Don't claim production-grade sandbox isolation on Daytona cloud — say it's the demo layer.
- Don't let the model narrate the verdict — the canary does.
- Don't type anything live you can paste.
- Don't run the dynamic clone-and-build tier live unless the provisioning spike and a full rehearsal both went green today, on this network. This is a demo-risk decision, not a scope limit: the tier is designed and documented, and on stage it is a walkthrough of the two-sandbox diagram. The build is the one step that needs the network the rest of the demo brags about not having, and that is not a sentence to improvise.
- Don't demo email or file-upload intake as live. They are designed channels; show the UI and say so.
- Don't clone or install anything at runtime on stage. The image is prebuilt and the sandbox is offline; that's the point.
