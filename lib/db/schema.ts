import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** A GitHub App installation. Suspension and deletion are recorded, never hard-deleted. */
export const githubInstallation = pgTable(
  "github_installation",
  {
    id: id(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
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
    targetProfileId: uuid("target_profile_id").references(() => targetProfile.id),
    active: boolean("active").notNull().default(true),
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
export const targetProfile = pgTable("target_profile", {
  id: id(),
  name: text("name").notNull(),
  imageDigest: text("image_digest").notNull(),
  snapshotId: text("snapshot_id"),
  /** Endpoints, scenarios, canary seeding config. */
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  /** Allowed hosts/paths; consulted by scope-guard. */
  scopeRules: jsonb("scope_rules").notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** The human-facing report. Its state is the report lifecycle, never job execution. */
export const report = pgTable(
  "report",
  {
    id: id(),
    channel: intakeChannel("channel").notNull(),
    /** Stable pointer back to the origin, e.g. "acme/security-reports#482". */
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
 * A verdict draft. `contentHash` is what the approval binds to: publish_verdict refuses any
 * payload whose hash differs from the one a human actually approved.
 */
export const verdict = pgTable(
  "verdict",
  {
    id: id(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => report.id, { onDelete: "cascade" }),
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
      .references(() => verdict.id, { onDelete: "cascade" }),
    reviewer: text("reviewer").notNull(),
    decision: approvalOutcome("decision").notNull(),
    /** Must match verdict.contentHash, or the tool call is refused. */
    payloadHash: text("payload_hash").notNull(),
    note: text("note"),
    decidedAt: createdAt(),
  },
  (t) => [index("approval_decision_verdict_idx").on(t.verdictId)],
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
      .references(() => report.id, { onDelete: "cascade" }),
    verdictId: uuid("verdict_id")
      .notNull()
      .references(() => verdict.id, { onDelete: "cascade" }),
    state: deliveryState("state").notNull().default("PENDING"),
    /** Stable marker embedded in the comment; makes a retry a no-op rather than a duplicate. */
    idempotencyKey: text("idempotency_key").notNull(),
    target: text("target").notNull(),
    body: text("body").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("outbound_delivery_idempotency_key").on(t.idempotencyKey),
    index("outbound_delivery_state_idx").on(t.state),
  ],
);

/** Append-only audit trail. The one writer that runs without approval. */
export const sessionEvent = pgTable(
  "session_event",
  {
    id: id(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => report.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("session_event_report_seq_key").on(t.reportId, t.seq),
    index("session_event_report_idx").on(t.reportId),
  ],
);
