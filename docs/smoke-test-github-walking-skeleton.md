# Smoke test: GitHub walking skeleton

This check covers the live path that is safe before A4 exists: signed GitHub intake and the
deterministic analysis-only worker. The native TrueForge approval gate is not built yet, so
this procedure stops at `AWAITING_APPROVAL`. It does not insert approval or outbox rows by
hand and it does not post a live comment.

The delivery mechanics are covered separately by
`lib/e2e/github-delivery-mechanics.test.ts`, with GitHub replaced by a controlled HTTP
boundary. Live delivery waits for A4, because a database edit is not a substitute for the
required approval bound to `threadId`, `toolCallId` and the exact content hash.

## Prerequisites

- `.env.local` contains the GitHub App settings and platform webhook secret.
- The App is installed on the connected repository.
- The repository has a server-held target profile. This path does not start that target.
- GitHub can reach `/api/intake/github`, through the deployed host or a temporary local
  tunnel.

## Steps

1. Open a test issue on the connected repository. Confirm GitHub receives a 202 response and
   an `inbound_job` row exists in `RECEIVED`.

2. Run `npm run worker:jobs`. Confirm the job reaches `DONE`, the report reaches
   `AWAITING_APPROVAL`, and the report has one revision-one `ANALYSIS_ONLY` verdict.

3. Read the verdict payload. It must say that automated reproduction was not run. It must
   contain exactly one `<!-- bountydesk-delivery:<verdictId> -->` marker and must not claim a
   reproduced or not-reproduced result.

4. Recompute SHA-256 over the exact UTF-8 payload. Confirm it equals
   `verdict.content_hash`.

5. Confirm no `approval_decision` or `outbound_delivery` row was created. The stub may draft
   a verdict, but only A4's human-approved `publish_verdict` path may create a delivery.

6. Run `npm run worker:jobs` again. Confirm there is nothing claimable and no second verdict
   or analysis event was created.

Record the issue URL, job ID, report ID and pass or fail result in the PR. Do not include
credentials or webhook payload secrets.
