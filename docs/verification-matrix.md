# Verification matrix

A record of the scenario, state and channel coverage exercised after the private-intake and
any-source build landed. Automated tests cover the exhaustive state and refusal grid (see the
`*.test.ts` files named per area); this doc records the live production runs, with report ids, and
names the cells that are covered by test rather than run live and why.

Live runs used a throwaway vulnerable app (a UNION SQL injection on `/?id=` over an in-memory
sqlite users table, `/healthz` for readiness) and the two reporter mailboxes the account controls.
Report ids are the durable handle for each run.

## Bugs the live matrix found and fixed

Both were invisible to the unit-test sweep because the build driver is mocked there; only a real
Daytona build surfaced them.

- #310: `stageSource` wrote `/work/source.tgz` with a shell redirect before `/work` existed, so
  every non-git upload build failed with "can't create /work/source.tgz: nonexistent directory".
  The git branch was unaffected only because `git clone` creates the leading directory. Fixed by
  creating `/work` in the same command; a regression test asserts the write creates it.
- #312: the reproduction readiness and egress probe (`lib/sandbox/provision.ts`) only knew `curl`
  and `wget`, so any minimal target image (for example `python:3.11-slim`) failed reproduction with
  `COULD_NOT_DEPLOY`. Fixed with a listen-socket readiness fallback (a LISTEN entry for the port in
  `/proc/net/tcp`) when no HTTP client is present; egress verification stays fail-closed and leans
  on the already-asserted `networkBlockAll`.

Also recorded (copy fix in #313): Daytona runs its own entrypoint and does not exec the target
image's `CMD`, so a start command is effectively required. The Build-target dialog placeholder no
longer claims the image's own command runs by default.

## Intake to landing state

| Channel | Lands at | Live | Report |
|---|---|---|---|
| GitHub issue with `/reproduce` | TRIAGING | yes (earlier rounds) | prior issue reports |
| GitHub advisory (private vulnerability report) | NEEDS_DECISION | yes | 15986682 (GHSA-hh99) |
| Email, allowlisted sender | TRIAGING | yes | dbd39ca8 |
| Email, outside sender | NEEDS_DECISION | yes (earlier) | e959075a |
| Upload (`/submit`) | NEEDS_DECISION | yes | 1012f6cd, f3f611e8, a6a20cf1, 05c7fc29 |

## Reviewer gate

| Action | Result | Live | Report |
|---|---|---|---|
| Run analysis / release | TRIAGING | yes | 1012f6cd, 15986682 |
| Reject or spam | DENIED | yes (earlier) | e71bc08f |
| Build target and run | build then reproduce | yes | a6a20cf1, 05c7fc29 |
| Cancel a wedged report | CANCELLED | yes | cd754ef7 (via #304) |

## Outcome written back per channel

| Channel | Outcome | Live | Report |
|---|---|---|---|
| Advisory (description edit) | REPRODUCED | yes, marker + idempotent replay | 15986682 (GHSA-hh99), dbd39ca8 (GHSA-qr4w) |
| Email reply | REPRODUCED | yes, delivered on the Resend receipt | 1012f6cd |
| GitHub issue comment | REPRODUCED | yes (earlier rounds) | prior issue reports |
| Advisory onto a private repo | held for review | yes, correct fail-safe (repo has no advisory feature) | cd754ef7 |

NOT_REPRODUCED and ANALYSIS_ONLY write-backs per channel are covered by the delivery-arm and
publish-verdict tests; the advisory and email arms treat every publishable outcome the same way, so
the outcome does not change the delivery path that the REPRODUCED runs above exercised.

## Non-GitHub targets (`/submit` target material)

| Source | Result | Live | Report / target |
|---|---|---|---|
| Source tarball (multi-file, Dockerfile at root) | build, bind, REPRODUCED | yes | a6a20cf1 |
| Single Dockerfile, clientless image (no curl/wget) | build, bind, REPRODUCED via the #312 fallback | yes | 05c7fc29, target 4d0deb5f |
| Prebuilt image and digest | build (FROM name@digest), bind, identity anchor | test-covered (B3) plus the shared provision and reproduce path proven live above | live submit blocked: needs a public reproduce-capable image, and the `gh` token here lacks `read:packages` to make the pushed GHCR image public |

## Refusals and edge states

| Cell | Result | Live | Note |
|---|---|---|---|
| Build fails | tier-3 static, ANALYSIS_ONLY | yes | f3f611e8 (before #310) |
| Per-contact daily OTP limit | 429 | yes | vtking03 exhausted; switch contact |
| Private repo without Contents read | POLICY_REFUSED then ANALYSIS_ONLY | test-covered | private-repo-policy tests |
| Nothing read and nothing drafted | OUT_OF_SCOPE | test-covered | target-scope tests |
| Grant revoked mid-delivery, SPF/DKIM fail, lease loss, sweeper reclaim | held or refused | test-covered | need contrived infra to trigger live |

## Agent-authored `publish_verdict`, live proof

The SQLi live proof on record (`docs/demo-runbook.md`, `docs/decisions.md` Q18) predates Q22's
agent-authored redesign and used the deterministic canary pipeline instead. This run is the
first full pass of the current path: the TrueForge agent itself investigates and calls
`publish_verdict`, with no canary runner involved.

Target: the pinned fork `Vaibhav91one/juice-shop` at `v17.3.0`
(`ghcr.io/vaibhav91one/juice-shop@sha256:477b2ed9...`). Scenario: UNION SQL injection on
`GET /rest/products/search?q=`.

Sequence, with evidence:

1. Intake: issue [`Vaibhav91one/juice-shop#32`](https://github.com/Vaibhav91one/juice-shop/issues/32),
   opened with a `/reproduce` command by an allowlisted reviewer. GitHub App delivery
   `eb0a6342-c399-11f1-8618-bf6395f1a807`, response 202, `inbound_job`
   `d33c3007-b5b9-47fb-a20a-7562568f2125`.
   - A first attempt, issue #31, was opened without a `/reproduce` command. The receiver
     accepted and correctly dropped it (`lib/github/commands.ts` intent gate): 202 "no
     /reproduce command, not triggering a run", no job row. Not a defect; closed as superseded.
2. Report `65316ec8-5f9e-4b0c-84b6-020aae66c621` created, `source_ref
   github:1347703889:issue:32`.
3. Agent session `9ccc8b70-2da3-4258-8b20-de244020683e` investigated against sandbox
   `b5357ca7-116d-4a09-a7a9-29117d07d474`, then called `publish_verdict`
   (`call_Gyjf8nH43MCYGzqOHfu2YmAg`); the turn ended on the pending call and the report moved to
   AWAITING_APPROVAL.
4. Verdict `f2595dc5-628b-4f54-809d-f8bc3110a867`, revision 1, outcome `REPRODUCED`, content hash
   `56e49ded8c7d5697199836fab7fff7e5aab58368b8b337a2fbcd748e14590acb`.
5. A reviewer read the exact drafted text on the case file and approved it
   (`approval_decision` `1d1ab72b-5f4c-4e56-954b-2dafebf7f9c7`).
6. Delivered as [comment 6074364696](https://github.com/Vaibhav91one/juice-shop/issues/32#issuecomment-6074364696),
   report state `DELIVERED`.

This is the first live run of the current agent-authored path; the August 2026 proof under the
deterministic canary pipeline still stands as a separate, earlier proof and is not superseded.

## Cleanup performed this round

- Three test advisories on juice-shop closed (`GHSA-qr4w`, `GHSA-q5pc`, `GHSA-hh99`). GitHub has no
  API delete for a repository security advisory, only close, so closed is the available withdrawal.
- Report `cd754ef7` (a permanently-held advisory delivery on a private repo) moved to CANCELLED
  through the new reviewer cancel action.
