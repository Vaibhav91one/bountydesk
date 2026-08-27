# Smoke test: GitHub walking skeleton

This is the live check for the path this PR adds: a real signed GitHub issue turns into a
durable job and report, the stub analysis driver produces an `ANALYSIS_ONLY` verdict, and the
delivery worker posts a comment through a real installation token. Run it by hand against the
connected repository (`Vaibhav91one/juice-shop`) after CI is green, before merging.

There is no production approval trigger yet. A4 (the TrueForge session/turn driver and the
native `publish_verdict` gate) is what will let a human actually approve a verdict in the app.
Until then, step 4 below inserts the approval and outbox rows by hand with `drizzle-kit
studio` or a short script, standing in for that gate. Do not build a shortcut for this in the
app itself; that is exactly the custom checkpoint `docs/decisions.md` Q11 rules out.

## Prerequisites

- `.env.local` filled in for the GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_BASE64`,
  `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID/SECRET`), pointed at a real App installed
  on the connected repository.
- `WORKER_INTERNAL_SECRET` set, matching whatever you send as the `Authorization: Bearer`
  header when hitting the internal tick routes.
- The connected repository already bound to a `target_profile` (any profile works here; this
  path never touches the sandbox).
- A public tunnel (`GITHUB_WEBHOOK_BASE_URL`) if you're testing against a locally running app,
  or a deployed environment with the webhook URL configured on the App itself.

## Steps

1. Open a real issue on the connected repository. GitHub delivers the signed webhook to
   `/api/intake/github`; confirm it returns 202 and an `inbound_job` row exists in `RECEIVED`.

2. Drive the job queue:
   ```
   npm run worker:jobs
   ```
   Confirm the report reaches `AWAITING_APPROVAL` and has a `verdict` row with
   `outcome: ANALYSIS_ONLY`. Read the `payload` text: it must say plainly that automated
   reproduction was not performed, and must not use language implying a reproduced or
   not-reproduced result.

3. Confirm the hash: `verdict.contentHash` should equal the sha256 hex digest of
   `verdict.payload` (this is exactly what `lib/verdicts/hash.ts`'s `computeContentHash`
   computes; you can check it from a Node REPL against the same payload string).

4. Stand in for the human approval that A4 will provide for real. Using `npm run db:studio` or
   a short one-off script:
   - Insert an `approval_decision` row for the verdict (`decision: APPROVED`, `payloadHash`
     equal to `verdict.contentHash`).
   - Move the report from `AWAITING_APPROVAL` to `DELIVERING`.
   - Insert an `outbound_delivery` row (`state: PENDING`, `idempotencyKey:
     verdict:<verdictId>`, `target` equal to the report's `sourceRef`, `approvedContentHash`
     equal to `verdict.contentHash`).

5. Drive the outbox:
   ```
   npm run worker:delivery
   ```
   Confirm the comment lands on the real issue, that its text matches `verdict.payload`
   exactly (including the hidden `<!-- bountydesk-delivery:<verdictId> -->` marker at the
   bottom), that `outbound_delivery.state` is `SENT`, and that the report is `DELIVERED`.

6. Confirm the replay guard: run `npm run worker:delivery` again. The row is no longer
   `PENDING`, so nothing should be claimed and no second comment should appear. To test the
   actual crash-recovery path (not just the no-op), set the `outbound_delivery` row back to
   `PENDING` with its lease cleared and run the tick again; the worker should find its own
   marker on the issue and mark the delivery `SENT` without posting a second comment.

7. Check `github_installation`, `connected_repository`, and `delivery_attempt` for anything
   that shouldn't be there: no row should contain the App JWT or the installation token in any
   column.

Record the result (pass/fail, and anything that needed a workaround) in the PR before merging.
