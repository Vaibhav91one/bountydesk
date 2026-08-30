import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The two state models are deliberately separate (see AGENTS.md and docs/decisions.md Q14).
 * Job execution tracks whether we managed to process a delivery at all; report lifecycle
 * tracks where the human-facing report has got to. Conflating them is how DEAD_LETTER ends
 * up leaking into a reviewer's queue.
 */
export const jobExecutionState = pgEnum("job_execution_state", [
  "RECEIVED",
  "PARSED",
  "SESSION_CREATED",
  "RUNNING",
  "DONE",
  "DEAD_LETTER",
]);

export const reportLifecycleState = pgEnum("report_lifecycle_state", [
  "TRIAGING",
  "REPRODUCING",
  "ANALYSIS_ONLY",
  "AWAITING_APPROVAL",
  "DELIVERING",
  // Terminal from here down.
  "DELIVERED",
  "DENIED",
  "OUT_OF_SCOPE",
  "CANCELLED",
  "EXPIRED",
]);

export const REPORT_TERMINAL_STATES = [
  "DELIVERED",
  "DENIED",
  "OUT_OF_SCOPE",
  "CANCELLED",
  "EXPIRED",
] as const;

export const intakeChannel = pgEnum("intake_channel", [
  "github",
  "email",
  "manual",
]);

export const verdictOutcome = pgEnum("verdict_outcome", [
  "REPRODUCED",
  "NOT_REPRODUCED",
  "INCONCLUSIVE",
  "ANALYSIS_ONLY",
]);

export const approvalOutcome = pgEnum("approval_outcome", [
  "APPROVED",
  "DENIED",
]);

export const deliveryState = pgEnum("delivery_state", [
  "PENDING",
  "SENT",
  "FAILED",
]);

export const scopeGuardAuditVerdict = pgEnum("scope_guard_audit_verdict", [
  "allowed",
  "denied",
  "mutated",
]);

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A GitHub App installation.
 *
 * `deletedAt` is a tombstone. GitHub issues a new installation id when an account installs
 * the App again, so nothing legitimate ever needs this row brought back, and never clearing
 * it means an out-of-order or redelivered `installation.created` cannot resurrect access.
 */
export const githubInstallation = pgTable(
  "github_installation",
  {
    id: id(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    /**
     * "User" or "Organization". GitHub puts an organization's installation settings on a
     * different path from a personal one, so a link built without this sends half of all
     * operators to a 404. Nullable because rows written before this column existed have
     * no answer, and guessing one would be worse than falling back.
     */
    accountType: text("account_type"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("github_installation_installation_id_key").on(t.installationId)],
);

/** A repository the installation granted us. Resolving repo -> target happens here, server-side. */
export const connectedRepository = pgTable(
  "connected_repository",
  {
    id: id(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    fullName: text("full_name").notNull(),
    /**
     * Which target the sandbox may touch for this repository. Null means the operator has
     * not configured it, and intake refuses the repository until they do. Only an operator
     * sets this; no webhook ever does, which is what keeps a stale delivery from restoring
     * intake on its own.
     */
    targetProfileId: uuid("target_profile_id").references(() => targetProfile.id),
    /** The installation grant: did the account select this repository for the App? */
    active: boolean("active").notNull().default(true),
    /** Repository archive state, tracked apart from the grant so neither overwrites the other. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("connected_repository_repo_id_key").on(t.repoId),
    index("connected_repository_installation_idx").on(t.installationId),
  ],
);

/**
 * What the sandbox is allowed to touch. Scope is bound here, at the capability boundary,
 * never taken from a string the agent produced.
 */
export const targetProfile = pgTable(
  "target_profile",
  {
    id: id(),
    name: text("name").notNull(),
    /**
     * Registry and repository, e.g. "ghcr.io/vaibhav91one/juice-shop". No tag, no digest.
     * Nullable for now: staged this way so the migration does not depend on a data repair
     * landing first. Application code refuses to write a profile with no image name; a later
     * migration makes the column NOT NULL once no existing row can violate it.
     */
    imageName: text("image_name"),
    imageDigest: text("image_digest").notNull(),
    snapshotId: text("snapshot_id"),
    /** Endpoints, scenarios, canary seeding config. */
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    /** Allowed hosts/paths; consulted by scope-guard. */
    scopeRules: jsonb("scope_rules").notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("target_profile_name_key").on(t.name)],
);

/** The human-facing report. Its state is the report lifecycle, never job execution. */
export const report = pgTable(
  "report",
  {
    id: id(),
    channel: intakeChannel("channel").notNull(),
    /** Stable pointer back to the origin, e.g. "github:123456:issue:482". */
    sourceRef: text("source_ref").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    reporterHandle: text("reporter_handle"),
    state: reportLifecycleState("state").notNull().default("TRIAGING"),
    connectedRepositoryId: uuid("connected_repository_id").references(
      () => connectedRepository.id,
    ),
    targetProfileId: uuid("target_profile_id").references(() => targetProfile.id),
    /** Set only once a human-approved outcome exists; feeds semantic dedupe candidates. */
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("report_channel_source_ref_key").on(t.channel, t.sourceRef),
    index("report_state_idx").on(t.state),
  ],
);

/**
 * The durable queue. Idempotency is the unique (channel, delivery_id) row, and the decision
 * is made on `state`, not on whether the row exists: a redelivery of something already
 * finished is a no-op, one still in flight is left alone.
 */
export const inboundJob = pgTable(
  "inbound_job",
  {
    id: id(),
    channel: intakeChannel("channel").notNull(),
    /** X-GitHub-Delivery, or the equivalent per channel. */
    deliveryId: text("delivery_id").notNull(),
    state: jobExecutionState("state").notNull().default("RECEIVED"),
    payload: jsonb("payload").notNull(),
    reportId: uuid("report_id").references(() => report.id),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /**
     * Bumped on every claim. A worker holds the fence it was issued and must present it to
     * mutate the job, so one that stalled past its lease cannot write over the worker that
     * legitimately took over: its fence is stale and the update matches no rows.
     */
    fence: bigint("fence", { mode: "number" }).notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("inbound_job_channel_delivery_id_key").on(t.channel, t.deliveryId),
    // The claim query filters on state + next_attempt_at and orders by next_attempt_at.
    index("inbound_job_claim_idx").on(t.state, t.nextAttemptAt),
    index("inbound_job_lease_idx").on(t.leaseExpiresAt),
  ],
);

/**
 * Lifecycle webhook deliveries we have already applied.
 *
 * GitHub keeps the delivery id when a webhook is redelivered, by its own retries or by
 * someone pressing Redeliver. Without this row, replaying an old `installation.created`
 * after an uninstall would clear `deleted_at` and hand access back. Issue deliveries are
 * not recorded here: they get their idempotency from the `inbound_job` row.
 */
export const lifecycleDelivery = pgTable(
  "lifecycle_delivery",
  {
    id: id(),
    /** X-GitHub-Delivery. */
    deliveryId: text("delivery_id").notNull(),
    event: text("event").notNull(),
    action: text("action"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("lifecycle_delivery_delivery_id_key").on(t.deliveryId)],
);

/**
 * A verdict draft. `contentHash` is what the approval binds to: publish_verdict refuses any
 * payload whose hash differs from the one a human actually approved.
 */
export const verdict = pgTable(
  "verdict",
  {
    id: id(),
    // No cascade: a verdict is evidence. Deleting the report must not silently erase it.
    reportId: uuid("report_id")
      .notNull()
      .references(() => report.id, { onDelete: "restrict" }),
    outcome: verdictOutcome("outcome").notNull(),
    summary: text("summary").notNull(),
    /** Canary result, negative control, action log, artifact refs. */
    evidence: jsonb("evidence").notNull().default(sql`'{}'::jsonb`),
    /** The exact outbound comment body that would be posted. */
    payload: text("payload").notNull(),
    contentHash: text("content_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("verdict_report_revision_key").on(t.reportId, t.revision),
    index("verdict_report_idx").on(t.reportId),
  ],
);

/** Immutable record of a human decision. Never updated, only inserted. */
export const approvalDecision = pgTable(
  "approval_decision",
  {
    id: id(),
    verdictId: uuid("verdict_id")
      .notNull()
      .references(() => verdict.id, { onDelete: "restrict" }),
    reviewer: text("reviewer").notNull(),
    decision: approvalOutcome("decision").notNull(),
    /** Must match verdict.contentHash, or the tool call is refused. */
    payloadHash: text("payload_hash").notNull(),
    /**
     * Which pending TrueForge tool call this decision answers. `publish_verdict`'s handler
     * refuses to act on an approval that doesn't name the exact call it was invoked for; a
     * decision recorded for a stale or different pending call must never be reused.
     */
    threadId: text("thread_id"),
    toolCallId: text("tool_call_id"),
    note: text("note"),
    decidedAt: createdAt(),
  },
  (t) => [
    // One decision per verdict revision. A reviewer who wants a different answer produces a
    // new revision; they do not get to decide the same artifact twice.
    uniqueIndex("approval_decision_verdict_key").on(t.verdictId),
    check(
      "approval_decision_call_all_or_none",
      sql`(${t.threadId} is null) = (${t.toolCallId} is null)`,
    ),
  ],
);

/**
 * Outbox. Written in the same transaction as the approved verdict, drained by a worker, so
 * a crash between "approved" and "posted" cannot lose the delivery or double-post it.
 */
export const outboundDelivery = pgTable(
  "outbound_delivery",
  {
    id: id(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => report.id, { onDelete: "restrict" }),
    verdictId: uuid("verdict_id")
      .notNull()
      .references(() => verdict.id, { onDelete: "restrict" }),
    state: deliveryState("state").notNull().default("PENDING"),
    /** Stable marker embedded in the comment; makes a retry a no-op rather than a duplicate. */
    idempotencyKey: text("idempotency_key").notNull(),
    target: text("target").notNull(),
    /**
     * Deliberately no `body` column. The outgoing text is read from the immutable
     * verdict.payload at send time and checked against this hash, which is copied from the
     * approval. A second mutable copy of the body would be a way to have a human approve one
     * thing and GitHub receive another.
     */
    approvedContentHash: text("approved_content_hash").notNull(),
    requiresHumanReview: boolean("requires_human_review")
      .notNull()
      .default(false),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    lastError: text("last_error"),
    /**
     * Leasing mirrors `inbound_job` exactly (same claim/fence/backoff shape in
     * lib/delivery/queue.ts), because draining an outbox under concurrent workers is the same
     * problem as draining the inbound queue.
     */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    fence: bigint("fence", { mode: "number" }).notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("outbound_delivery_idempotency_key").on(t.idempotencyKey),
    uniqueIndex("outbound_delivery_automatic_target_key")
      .on(t.verdictId, t.target)
      .where(sql`${t.requiresHumanReview} = false`),
    index("outbound_delivery_state_idx").on(t.state),
    index("outbound_delivery_claim_idx").on(t.state, t.nextAttemptAt),
    index("outbound_delivery_lease_idx").on(t.leaseExpiresAt),
  ],
);

/**
 * One row per delivery attempt, request and response. The counter on outbound_delivery says
 * how many times we tried; this says what actually happened each time, which is what an
 * incident review needs.
 */
export const deliveryAttempt = pgTable(
  "delivery_attempt",
  {
    id: id(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => outboundDelivery.id, { onDelete: "restrict" }),
    attempt: integer("attempt").notNull(),
    /** HTTP status, or null when the request never got a response. */
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("delivery_attempt_delivery_attempt_key").on(t.deliveryId, t.attempt),
    index("delivery_attempt_delivery_idx").on(t.deliveryId),
  ],
);

/** Append-only audit trail. The one writer that runs without approval. */
export const sessionEvent = pgTable(
  "session_event",
  {
    id: id(),
    // No cascade: deleting a report must not take its audit trail with it.
    reportId: uuid("report_id")
      .notNull()
      .references(() => report.id, { onDelete: "restrict" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    /** Stable key for retryable worker events. Null for events that are intentionally repeatable. */
    eventKey: text("event_key"),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("session_event_report_seq_key").on(t.reportId, t.seq),
    uniqueIndex("session_event_report_event_key_key").on(t.reportId, t.eventKey),
    index("session_event_report_idx").on(t.reportId),
  ],
);

/**
 * The TrueForge side of one report: its session, its current turn, and, while one is open,
 * the exact pending `publish_verdict` call awaiting a decision.
 *
 * `capabilityToken` is the only report identifier the model ever sees: it is passed into the
 * turn's input and echoed back as the tool's sole argument, so a report is never selected by a
 * caller-supplied id. Lease columns mirror `inbound_job`/`outbound_delivery` exactly, because
 * both the poller and the approval-submission worker claim rows here the same way those
 * workers claim theirs.
 */
export const agentSession = pgTable(
  "agent_session",
  {
    id: id(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => report.id, { onDelete: "restrict" }),
    capabilityToken: text("capability_token").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id"),
    /** Local bookkeeping only, never a report state: RUNNING | INVESTIGATING | AWAITING_APPROVAL_HARNESS | DONE_NO_ACTION | ERROR | CANCELLED. */
    turnStatus: text("turn_status").notNull().default("RUNNING"),
    /**
     * The id of the newest TrueForge turn event the poller has already mirrored into
     * session_event (see lib/agent-sessions/poller.ts's mirrorToolCalls). Event ids are
     * monotonic ULIDs, so "newer than this" is a plain string comparison. Lets a poll ask
     * TrueForge for only the events since the last one it processed instead of walking the
     * turn's entire history every tick; session_event's own unique event_key stays the
     * correctness backstop if this cursor ever lags a retry.
     */
    lastMirroredEventId: text("last_mirrored_event_id"),
    pendingThreadId: text("pending_thread_id"),
    pendingToolCallId: text("pending_tool_call_id"),
    pendingVerdictId: uuid("pending_verdict_id").references(() => verdict.id),
    pendingApprovedContentHash: text("pending_approved_content_hash"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    fence: bigint("fence", { mode: "number" }).notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("agent_session_report_id_key").on(t.reportId),
    uniqueIndex("agent_session_capability_token_key").on(t.capabilityToken),
    uniqueIndex("agent_session_session_id_key").on(t.sessionId),
    index("agent_session_poll_idx").on(t.turnStatus, t.nextPollAt),
    index("agent_session_lease_idx").on(t.leaseExpiresAt),
    // Every pending_* column is populated together or not at all; a partial pending state
    // would mean the poller and the publish handler could each see a different half of it.
    check(
      "agent_session_pending_all_or_none",
      sql`(${t.pendingThreadId} is null) = (${t.pendingToolCallId} is null)
          and (${t.pendingToolCallId} is null) = (${t.pendingVerdictId} is null)
          and (${t.pendingVerdictId} is null) = (${t.pendingApprovedContentHash} is null)`,
    ),
  ],
);

export const agentSessionClaim = pgTable(
  "agent_session_claim",
  {
    reportId: uuid("report_id")
      .primaryKey()
      .references(() => report.id, { onDelete: "restrict" }),
    claimToken: text("claim_token").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

/**
 * The durable, retryable act of telling TrueForge about a decision already recorded in
 * `approval_decision`. Separate from the decision itself: a crash between "we decided" and
 * "TrueForge knows" must always be recoverable by retrying this row, never ambiguous about
 * whether the decision itself happened.
 */
export const approvalSubmission = pgTable(
  "approval_submission",
  {
    id: id(),
    agentSessionId: uuid("agent_session_id")
      .notNull()
      .references(() => agentSession.id, { onDelete: "restrict" }),
    approvalDecisionId: uuid("approval_decision_id")
      .notNull()
      .references(() => approvalDecision.id, { onDelete: "restrict" }),
    /** Set once TrueForge acknowledges the chained turn carrying this decision. */
    submittedTurnId: text("submitted_turn_id"),
    state: text("state").notNull().default("PENDING"), // PENDING | SUBMITTED | ACKNOWLEDGED | FAILED
    attempts: integer("attempts").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    fence: bigint("fence", { mode: "number" }).notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("approval_submission_approval_decision_key").on(t.approvalDecisionId),
    index("approval_submission_claim_idx").on(t.state, t.nextAttemptAt),
    index("approval_submission_lease_idx").on(t.leaseExpiresAt),
  ],
);

/**
 * The scope-guard hash-chained audit log (ported from Sentinel's JSONL file, see
 * lib/scope-guard/audit.ts). One global chain, not partitioned per report: scope-guard
 * governs one sandbox target, not one report at a time. `seq` and `prev_hash`/`hash` are
 * assigned atomically per insert (a transaction-scoped Postgres advisory lock serializes
 * appends; see audit.ts for why a plain `SELECT ... FOR UPDATE` on the latest row cannot do
 * this on its own), so no amount of concurrent appending can fork or duplicate the chain. The
 * insert-only trigger below matches session_event/verdict/approval_decision/delivery_attempt:
 * this is the one writer that runs without approval, and deleting from it is the first thing
 * an attacker would want to do.
 */
export const scopeGuardAudit = pgTable(
  "scope_guard_audit",
  {
    id: id(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor").notNull(),
    auth: text("auth").notNull(),
    action: text("action").notNull(),
    args: jsonb("args").notNull().default(sql`'{}'::jsonb`),
    verdict: scopeGuardAuditVerdict("verdict").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [
    uniqueIndex("scope_guard_audit_seq_key").on(t.seq),
    uniqueIndex("scope_guard_audit_hash_key").on(t.hash),
  ],
);

/**
 * Single-use grants backing `verify_grant`/`request_intrusive_approval`, replacing Sentinel's
 * in-memory `Map` (see lib/scope-guard/grants.ts). Minting a grant inserts an `issued` row;
 * consuming it inserts a matching `consumed` row rather than updating the issued one, which is
 * what lets this table stay insert-only like the audit log while still making double-spend
 * impossible: the two partial unique indexes below allow at most one `issued` and one
 * `consumed` row per token, and `verify_grant` takes out a `SELECT ... FOR UPDATE` on the
 * issued row before inserting the consumed one, so two callers racing the same token
 * serialize instead of both seeing "not yet consumed."
 */
export const scopeGuardGrant = pgTable(
  "scope_guard_grant",
  {
    id: id(),
    token: text("token").notNull(),
    target: text("target").notNull(),
    action: text("action").notNull(),
    event: text("event").notNull(),
    /** Set on the `issued` row; null on the `consumed` row that references the same token. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("scope_guard_grant_token_issued_key").on(t.token).where(sql`${t.event} = 'issued'`),
    uniqueIndex("scope_guard_grant_token_consumed_key").on(t.token).where(sql`${t.event} = 'consumed'`),
    index("scope_guard_grant_token_idx").on(t.token),
    check("scope_guard_grant_event_check", sql`${t.event} in ('issued', 'consumed')`),
  ],
);
