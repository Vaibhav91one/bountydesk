# Mobile API

The mobile reviewer app talks to `/api/mobile/v1/*`. Every route is a route handler (`route.ts`)
under `app/api/mobile/v1/`, so a URL like `/api/mobile/v1/inbox` maps to
`app/api/mobile/v1/inbox/route.ts`.

All routes run on the Node runtime (the Next.js edge build does not have filesystem or Postgres
access). The one exception is auth: Clerk middleware verifies the bearer token in `clerkMiddleware`
before the request reaches the handler, which a plain Node test process cannot run. From the
handler's point of view, auth is already done.

## Authentication

Every route except `GET /me` is gated by `mobileAuth({ write })` in `lib/mobile/auth.ts`, the same
allowlist re-check the web routes use. A bearer token that does not carry an allowlisted reviewer
email is refused before anything reads the database.

| Token state | Response | Why |
|---|---|---|
| Missing or invalid | `401` | No authenticated session. |
| Present, but the email is not on the reviewer allowlist | `403` | Not a reviewer. |
| Present, email is allowlisted but read-only | `403` on write routes, `200` on read routes | Read-only reviewers can browse, not approve or add reviewers. |

The `write` flag matters for routes that mutate state: approve, deny, chat, reviewer management,
and reviewer uploads. Read routes (me, home, queue, reports, inbox, connections, integrations,
email access list) need no write flag.

## Shared parameters

Query routes share two pagination parameters, parsed by `parsePage` in `lib/mobile/views.ts`:

- `limit` — 1 to 50, defaults to 20.
- `offset` — 0 or more, defaults to 0.

A value outside the range is a `400`. The response includes `nextOffset`, which is `null` when
there is no further page.

## Routes

### `GET /me`

No auth gate — this is the one route that does not require a token. Returns who the token
belongs to and whether the email is allowlisted.

```
200  { userId, email, login, role: "owner" | "member" | "read_only", allowlisted: boolean }
401  { error: "unauthenticated" }
```

### `GET /home`

The home screen summary (M13). Counts and phase totals.

```
200  { awaiting, needsReview, triaging, reproducing, analysisOnly, awaitingApproval, delivering,
       delivered, denied, outOfScope, cancelled, expired, phases: [{ key, label, total }] }
```

### `GET /queue`

The review board, grouped by phase (M14). Optional `phase` narrows the answer to one column to
keep paging coherent across its cards.

```
?query
  phase   a phase key from /home, or omitted for all columns
  limit, offset   shared pagination

200  { columns: [{ key, label, total, cards: [...], nextOffset }] }
400  invalid query
```

### `GET /inbox`

The inbox for M23: "needs you" (reports awaiting a verdict decision) and "earlier" (delivered,
denied, expired, etc.), newest first.

"needs you" comes from `listAwaitingReview` in `lib/reports/queue.ts`, which scans the full table
with no cap, so an old awaiting report never vanishes from the phone even when 200 newer rows exist.
"earlier" comes from `listAllReports`, which is capped at `INDEX_LIMIT` (200) for the reports index;
the section sets `truncated: true` when that cap was hit.

```
?query
  phase   "needs" or "earlier", or omitted for both sections
  limit, offset   shared pagination, applied per section

200  {
  needsYou:   { items: [...], total, nextOffset } | null,
  earlier:     { items: [...], total, nextOffset, truncated } | null
}
```

When `phase` is omitted, both sections are paged from offset 0. When `phase` is set, the
requested section is paged and the other is `null`. `truncated` is only present on `earlier`
and is `true` when `listAllReports` hit its `INDEX_LIMIT` cap.

### `GET /reports`

The report list (M15), with the same read model the web index page uses.

```
?query
  state   a report state enum value, or omitted for all
  q       a search string
  limit, offset   shared pagination

200  { reports: [...], nextOffset }
400  invalid query
```

### `GET /reports/{id}`

The case file (M12, M16, M22). Built by `mobileCaseView` in `lib/mobile/views.ts` on
`caseLiveView`, so the state, verdict and delivery match what the web page shows.

The response includes:

- `target` — the bound reproduction target (`{ id, name, imageDigest }`).
- `targetScope` — scope and provisioning from the target profile, for the M22 target-and-scope
  screen:
  - `imageDigest`, `snapshotId`, `buildMarker` — what the sandbox runs.
  - `scopeRules` — the scope-guard rules as JSON.
  - `readinessPath`, `startCommand` — how the target is started.
  - `egress` — always `"none"`; the sandbox blocks all egress at the network layer regardless of
    the profile's config.
- `delivery.transportReceipt` — a human-readable label for M12, derived from the delivery target
  (`issue comment`, `email delivered`, `advisory updated`).
- `verdict.payload` and `verdict.contentHash` — the exact text a reviewer signs and its hash.
  The approve/deny calls must send this hash back.

```
200  { id, title, state, phase, investigating, failed, target, targetScope, summary,
       destination, verdict: { id, revision, outcome, ... payload, contentHash },
       awaitingVerdictId, approval, delivery: { state, target, transportReceipt, ...,
       deliveredAt, requiresHumanReview }, events, toolCalls, appeals: [...] }
404  report not found
```

### `POST /reports/{id}/approve`

Approve the pending verdict (M12). Sends the verdict id and the content hash the phone received,
so a stale screen cannot approve text the reviewer never saw.

```
body
  { verdictId, contentHash }

204  no content — the verdict is published and delivery queued
400  invalid body or mismatched content hash
403  read-only reviewer
404  report not found
```

### `POST /reports/{id}/deny`

Deny a report held at `NEEDS_DECISION` or `AWAITING_APPROVAL` (M12).

```
body
  { verdictId, contentHash, reason: string }

204  no content
400  invalid body
403  read-only reviewer
404  report not found
```

### `POST /reports/{id}/chat`

The reviewer chat. A reviewer types a follow-up note; it lands as a `reviewer.message` event on
the report timeline.

```
body
  { clientRequestId: string, body: string }

204  no content
400  invalid body
403  read-only reviewer
404  report not found
```

`clientRequestId` is the client's own deduplication key; the same value sent twice produces one
message.

### `GET /connections`

The GitHub account connections table (M16). Read-only: the same rows the web page renders.

```
200  [{ id, repositoryFullName, status, scope, authorizing, createdAt, updatedAt }]
```

### `GET /integrations`

One row per platform (GitHub, email, upload), read-only (M16).

```
200  [{ id, name, type, configured: boolean }]
```

### `GET /integrations/email`

The email-channel reviewer allowlist (M17). Any reviewer may read it; only an owner may add
addresses.

```
200  [
  { email, role: "owner" | "member" | "read_only", verified: boolean,
    codeOutstanding: boolean, addedByEmail, createdAt }
]
```

A pending member shows `verified: false` and `codeOutstanding: true` when a code has been mailed
and not yet expired.

### `POST /integrations/email`

Add a pending reviewer. Owner-only. Creates or refreshes the pending row and mails the one-time
code through the same `startVerification` + `sendVerificationEmail` primitives the web action
uses, so the hashing, expiry, and attempt cap cannot drift.

```
body
  { email: string }

200  { ok: true, codeSent: true }           — code mailed
200  { ok: true, message: "..." }           — address was already verified (no-op)
400  invalid body or email shape
403  not an owner
503  row created but the code email failed to send
```

### `POST /integrations/email/verify`

Confirm a pending reviewer with the six-digit code that was mailed to them. Owner-only. Reuses
`verifyCode`, so the constant-time comparison, expiry check, and attempt cap are identical to the
web flow.

```
body
  { email: string, code: "123456" }

200  { ok: true }
400  invalid body, wrong code, or expired code
403  not an owner
```

### `POST /integrations/upload`

Reviewer upload a target for building (M28). The trusted twin of the public
`/api/intake/upload` route: the reviewer's session is the contact proof, so there is no one-time
code round trip and no daily rate limit. The material is validated by the same `parseUploadForm`
the public route uses, so the size caps, tarball sniff, and image-registry allowlist hold
identically.

The form fields are the same as the web upload action in `app/review/actions.ts`: `title`,
`body`, `contact` (overwritten with the reviewer's email), `material` (one of `archive`, `image`,
`git`), `port`, `readinessPath`, `startCommand`, and `ecosystem`.

```
Content-Type: multipart/form-data
Accept: multipart/form-data (415 if anything else)

10413  (the request is capped before parsing)

202  { reportId }
400  invalid form body
403  not a reviewer with write access
415  not multipart/form-data
```

## Existing public upload intake routes

The public `/submit` page and its routes are documented in
`docs/upload-and-nongithub-targets.md`. They are JSON/multipart callable and listed here for
reference, but are unchanged by this work.

- `POST /api/intake/upload` — accepts a multipart form (title, body, contact, material), caps the
  request at 4 MB, validates the material, creates an `upload` report at `NEEDS_DECISION`, and
  mails the contact a one-time code. No account required.
- `POST /api/intake/upload/verify` — confirms the code for a pending upload report's contact, at
  most three codes per report. The contact is never taken from the request body; only the address
  given at upload can receive one.

The reviewer upload route above skips both the OTP and the rate limit, because the reviewer's
session is itself the proof of identity.

## Case view fields

`mobileCaseView` in `lib/mobile/views.ts` is the single source of the case file the phone renders.
It wraps `caseLiveView` from `lib/reports/case-view.ts`, so every state, verdict, and delivery
field matches the web page and its status poll.

- Events come from the mirrored poller output (`agent.tool_call:<name>` events), with only the
  tool name and an allowlisted argument preview — never the full arguments the web hover shows.
- `verdict.payload` is the exact text the approval gate signs; `verdict.contentHash` is its hash.
  Approve and deny send that hash back, and the gate refuses a mismatch.
- `awaitingVerdictId` is non-null only when there is a pending verdict waiting on a reviewer.
- `delivery.transportReceipt` is derived by `transportReceiptFor` from the delivery target format
  (`github:<repoId>:issue:<num>` → `issue comment`, an email address → `email delivered`, a
  `GHSA...` id → `advisory updated`).

## Sandbox (M26)

The case file already returns `target` and `sandbox` (the provisioned sandbox id and app port).
The mobile sandbox screen renders that data plus the static text from
`docs/sandbox-architecture.md` and the `targetScope` fields above. No separate route is needed.

## Push notifications

The mobile app registers a push token with `POST /push-token`. The token belongs to the reviewer email
from `mobileAuth().session.email`, so it is scoped to whoever signed in. The sweep that fires pushes
runs from `sweepPushNotifications` in `lib/push/notify.ts`, called by the `push-notifications` queue
entry in `scripts/run-worker-daemon.ts` every 60 seconds.

### `POST /push-token`

Register or refresh a push token for the signed-in reviewer.

```
body
  { token: string, platform: "ios" | "android" }

200  { ok: true }
400  invalid token or platform
401  not authenticated
403  not a reviewer
```

The token must match `/^ExponentPushToken\[[A-Za-z0-9_-]+\]$/` and be at most 200 characters. An
existing token is upserted: `reviewer_email`, `platform`, `last_seen_at`, and `revoked_at` are
cleared.

### `DELETE /push-token`

Revoke the reviewer's own token.

```
body
  { token: string }

204  no content
400  invalid token
401  not authenticated
403  not a reviewer
404  the token does not belong to the caller
```

### Payload rules

A push carries ids and a short title only. It never carries report text, verdict titles, findings, or
emails, since it passes through Apple's and Google's networks:

- `AWAITING_APPROVAL`: title "Verdict awaiting approval", body is the report's source label (for example
  `#482` or `#abcdef12`), data `{ reportId, screen: "sign" }`.
- `DELIVERED`: title "Verdict delivered", body is the report's source label, data `{ reportId, screen:
  "case" }`.

### Once-per-ref

Each notification is recorded as one row in `notification_event`, keyed by `(report_id, kind, ref_id)`.
A sweep inserts with `ON CONFLICT DO NOTHING`, so a report that stayed in `AWAITING_APPROVAL` through
multiple sweeps produces exactly one push. The same row also makes a `DELIVERED` report fire once per
outbound delivery id.

### Allowlist re-check

At send time, every token's `reviewer_email` is re-checked with `isReviewerEmail`. A reviewer removed
from the allowlist between registration and the sweep receives no pushes. A token that returns
`DeviceNotRegistered` from Expo is revoked (`revoked_at` set) so it is skipped on later sweeps.

## Testing

`app/api/mobile/v1/mobile.test.ts` exercises the full gate matrix against a disposable schema:
401 without a token, 403 for a non-allowlisted account, 403 for a read-only reviewer on write
routes, and the happy path for each new read and write route. The DAL and the reviewer check are
mocked so the test controls who is calling; the route handlers, `decide`, and the queries are real.
