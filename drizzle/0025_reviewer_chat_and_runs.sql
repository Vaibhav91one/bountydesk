CREATE TYPE "public"."investigation_run_reason" AS ENUM('INITIAL', 'REVIEWER_GUIDANCE', 'REPORTER_REPLY');--> statement-breakpoint
CREATE TYPE "public"."investigation_run_status" AS ENUM('PENDING', 'RUNNING', 'AWAITING_APPROVAL', 'SUPERSEDED', 'DONE', 'ERROR', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."reviewer_chat_message_sender" AS ENUM('REVIEWER', 'AGENT', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."reviewer_chat_thread_status" AS ENUM('OPEN', 'RUNNING', 'DONE', 'ERROR', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "investigation_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"run_number" integer NOT NULL,
	"parent_run_id" uuid,
	"reason" "investigation_run_reason" NOT NULL,
	"status" "investigation_run_status" DEFAULT 'PENDING' NOT NULL,
	"trueforge_session_id" text,
	"current_turn_id" text,
	"target_profile_id" uuid,
	"target_identity_hash" text,
	"guidance_hash" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"fence" bigint DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investigation_run_report_id_key" UNIQUE("report_id","id")
);
--> statement-breakpoint
CREATE TABLE "reviewer_chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"client_request_id" text NOT NULL,
	"sender" "reviewer_chat_message_sender" NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"model_name" text,
	"provider_turn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviewer_chat_message_body_length_check" CHECK (char_length("reviewer_chat_message"."body") between 1 and 20000),
	CONSTRAINT "reviewer_chat_message_request_id_check" CHECK (char_length("reviewer_chat_message"."client_request_id") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "reviewer_chat_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"verdict_id" uuid,
	"verdict_revision" integer,
	"verdict_content_hash" text,
	"reviewer_id" text NOT NULL,
	"trueforge_session_id" text,
	"status" "reviewer_chat_thread_status" DEFAULT 'OPEN' NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"fence" bigint DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviewer_chat_thread_verdict_snapshot_check" CHECK (("reviewer_chat_thread"."verdict_id" is null and "reviewer_chat_thread"."verdict_revision" is null and "reviewer_chat_thread"."verdict_content_hash" is null)
        or ("reviewer_chat_thread"."verdict_id" is not null and "reviewer_chat_thread"."verdict_revision" is not null and "reviewer_chat_thread"."verdict_content_hash" is not null))
);
--> statement-breakpoint
CREATE TABLE "verdict_supersession" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"old_verdict_id" uuid NOT NULL,
	"superseded_by_run_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"guidance_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verdict" ADD CONSTRAINT "verdict_report_id_key" UNIQUE("report_id","id");--> statement-breakpoint
ALTER TABLE "investigation_run" ADD CONSTRAINT "investigation_run_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_run" ADD CONSTRAINT "investigation_run_target_profile_id_target_profile_id_fk" FOREIGN KEY ("target_profile_id") REFERENCES "public"."target_profile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_run" ADD CONSTRAINT "investigation_run_parent_run_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."investigation_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_run" ADD CONSTRAINT "investigation_run_report_parent_fk" FOREIGN KEY ("report_id","parent_run_id") REFERENCES "public"."investigation_run"("report_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_chat_message" ADD CONSTRAINT "reviewer_chat_message_thread_id_reviewer_chat_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."reviewer_chat_thread"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_chat_thread" ADD CONSTRAINT "reviewer_chat_thread_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_chat_thread" ADD CONSTRAINT "reviewer_chat_thread_verdict_id_verdict_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdict"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_chat_thread" ADD CONSTRAINT "reviewer_chat_thread_report_verdict_fk" FOREIGN KEY ("report_id","verdict_id") REFERENCES "public"."verdict"("report_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdict_supersession" ADD CONSTRAINT "verdict_supersession_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdict_supersession" ADD CONSTRAINT "verdict_supersession_old_verdict_id_verdict_id_fk" FOREIGN KEY ("old_verdict_id") REFERENCES "public"."verdict"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdict_supersession" ADD CONSTRAINT "verdict_supersession_superseded_by_run_id_investigation_run_id_fk" FOREIGN KEY ("superseded_by_run_id") REFERENCES "public"."investigation_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdict_supersession" ADD CONSTRAINT "verdict_supersession_report_verdict_fk" FOREIGN KEY ("report_id","old_verdict_id") REFERENCES "public"."verdict"("report_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdict_supersession" ADD CONSTRAINT "verdict_supersession_report_run_fk" FOREIGN KEY ("report_id","superseded_by_run_id") REFERENCES "public"."investigation_run"("report_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_run_report_run_number_key" ON "investigation_run" USING btree ("report_id","run_number");--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_run_trueforge_session_id_key" ON "investigation_run" USING btree ("trueforge_session_id");--> statement-breakpoint
CREATE INDEX "investigation_run_report_idx" ON "investigation_run" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "investigation_run_parent_idx" ON "investigation_run" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "investigation_run_status_idx" ON "investigation_run" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "reviewer_chat_message_thread_request_key" ON "reviewer_chat_message" USING btree ("thread_id","client_request_id");--> statement-breakpoint
CREATE INDEX "reviewer_chat_message_thread_idx" ON "reviewer_chat_message" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "reviewer_chat_thread_report_idx" ON "reviewer_chat_thread" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "reviewer_chat_thread_verdict_idx" ON "reviewer_chat_thread" USING btree ("verdict_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviewer_chat_thread_active_verdict_key" ON "reviewer_chat_thread" USING btree ("report_id","verdict_id") WHERE "reviewer_chat_thread"."status" in ('OPEN', 'RUNNING') and "reviewer_chat_thread"."verdict_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "reviewer_chat_thread_active_report_key" ON "reviewer_chat_thread" USING btree ("report_id") WHERE "reviewer_chat_thread"."status" in ('OPEN', 'RUNNING') and "reviewer_chat_thread"."verdict_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "reviewer_chat_thread_trueforge_session_id_key" ON "reviewer_chat_thread" USING btree ("trueforge_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verdict_supersession_old_verdict_id_key" ON "verdict_supersession" USING btree ("old_verdict_id");--> statement-breakpoint
CREATE INDEX "verdict_supersession_report_idx" ON "verdict_supersession" USING btree ("report_id");--> statement-breakpoint
-- These records are server-side only. RLS stays enabled without policies, matching the existing
-- application tables and keeping the Supabase Data API closed by default.
ALTER TABLE "investigation_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reviewer_chat_thread" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reviewer_chat_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "verdict_supersession" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Chat messages and supersession links are evidence. Their lease and status live on the parent
-- rows, so neither child table needs an UPDATE path.
CREATE TRIGGER reviewer_chat_message_is_append_only
BEFORE UPDATE OR DELETE ON "reviewer_chat_message"
FOR EACH ROW EXECUTE FUNCTION bountydesk_deny_mutation();--> statement-breakpoint
CREATE TRIGGER verdict_supersession_is_append_only
BEFORE UPDATE OR DELETE ON "verdict_supersession"
FOR EACH ROW EXECUTE FUNCTION bountydesk_deny_mutation();
