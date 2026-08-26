CREATE TYPE "public"."approval_outcome" AS ENUM('APPROVED', 'DENIED');--> statement-breakpoint
CREATE TYPE "public"."delivery_state" AS ENUM('PENDING', 'SENT', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."intake_channel" AS ENUM('github', 'email', 'manual');--> statement-breakpoint
CREATE TYPE "public"."job_execution_state" AS ENUM('RECEIVED', 'PARSED', 'SESSION_CREATED', 'RUNNING', 'DONE', 'DEAD_LETTER');--> statement-breakpoint
CREATE TYPE "public"."report_lifecycle_state" AS ENUM('TRIAGING', 'REPRODUCING', 'ANALYSIS_ONLY', 'AWAITING_APPROVAL', 'DELIVERING', 'DELIVERED', 'DENIED', 'OUT_OF_SCOPE', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."verdict_outcome" AS ENUM('REPRODUCED', 'NOT_REPRODUCED', 'INCONCLUSIVE', 'ANALYSIS_ONLY');--> statement-breakpoint
CREATE TABLE "approval_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verdict_id" uuid NOT NULL,
	"reviewer" text NOT NULL,
	"decision" "approval_outcome" NOT NULL,
	"payload_hash" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connected_repository" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"target_profile_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_id" bigint NOT NULL,
	"suspended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "intake_channel" NOT NULL,
	"delivery_id" text NOT NULL,
	"state" "job_execution_state" DEFAULT 'RECEIVED' NOT NULL,
	"payload" jsonb NOT NULL,
	"report_id" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"verdict_id" uuid NOT NULL,
	"state" "delivery_state" DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text NOT NULL,
	"target" text NOT NULL,
	"body" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "intake_channel" NOT NULL,
	"source_ref" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"reporter_handle" text,
	"state" "report_lifecycle_state" DEFAULT 'TRIAGING' NOT NULL,
	"connected_repository_id" uuid,
	"target_profile_id" uuid,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "target_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"image_digest" text NOT NULL,
	"snapshot_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verdict" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"outcome" "verdict_outcome" NOT NULL,
	"summary" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" text NOT NULL,
	"content_hash" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_verdict_id_verdict_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdict"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_repository" ADD CONSTRAINT "connected_repository_installation_id_github_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_repository" ADD CONSTRAINT "connected_repository_target_profile_id_target_profile_id_fk" FOREIGN KEY ("target_profile_id") REFERENCES "public"."target_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_job" ADD CONSTRAINT "inbound_job_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_delivery" ADD CONSTRAINT "outbound_delivery_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_delivery" ADD CONSTRAINT "outbound_delivery_verdict_id_verdict_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdict"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_connected_repository_id_connected_repository_id_fk" FOREIGN KEY ("connected_repository_id") REFERENCES "public"."connected_repository"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_target_profile_id_target_profile_id_fk" FOREIGN KEY ("target_profile_id") REFERENCES "public"."target_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_event" ADD CONSTRAINT "session_event_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdict" ADD CONSTRAINT "verdict_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_decision_verdict_idx" ON "approval_decision" USING btree ("verdict_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connected_repository_repo_id_key" ON "connected_repository" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "connected_repository_installation_idx" ON "connected_repository" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installation_installation_id_key" ON "github_installation" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_job_channel_delivery_id_key" ON "inbound_job" USING btree ("channel","delivery_id");--> statement-breakpoint
CREATE INDEX "inbound_job_claim_idx" ON "inbound_job" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "inbound_job_lease_idx" ON "inbound_job" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_delivery_idempotency_key" ON "outbound_delivery" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_delivery_state_idx" ON "outbound_delivery" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "report_channel_source_ref_key" ON "report" USING btree ("channel","source_ref");--> statement-breakpoint
CREATE INDEX "report_state_idx" ON "report" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "session_event_report_seq_key" ON "session_event" USING btree ("report_id","seq");--> statement-breakpoint
CREATE INDEX "session_event_report_idx" ON "session_event" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verdict_report_revision_key" ON "verdict" USING btree ("report_id","revision");--> statement-breakpoint
CREATE INDEX "verdict_report_idx" ON "verdict" USING btree ("report_id");