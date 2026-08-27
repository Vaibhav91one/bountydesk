CREATE TABLE "agent_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"capability_token" text NOT NULL,
	"session_id" text NOT NULL,
	"turn_id" text,
	"turn_status" text DEFAULT 'RUNNING' NOT NULL,
	"pending_thread_id" text,
	"pending_tool_call_id" text,
	"pending_verdict_id" uuid,
	"pending_approved_content_hash" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"fence" bigint DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_pending_all_or_none" CHECK (("agent_session"."pending_thread_id" is null) = ("agent_session"."pending_tool_call_id" is null)
          and ("agent_session"."pending_tool_call_id" is null) = ("agent_session"."pending_verdict_id" is null)
          and ("agent_session"."pending_verdict_id" is null) = ("agent_session"."pending_approved_content_hash" is null))
);
--> statement-breakpoint
CREATE TABLE "approval_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"decision" "approval_outcome" NOT NULL,
	"submitted_turn_id" text,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"fence" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_decision" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "approval_decision" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_pending_verdict_id_verdict_id_fk" FOREIGN KEY ("pending_verdict_id") REFERENCES "public"."verdict"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_submission" ADD CONSTRAINT "approval_submission_agent_session_id_agent_session_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_report_id_key" ON "agent_session" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_capability_token_key" ON "agent_session" USING btree ("capability_token");--> statement-breakpoint
CREATE INDEX "agent_session_poll_idx" ON "agent_session" USING btree ("turn_status","next_poll_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_submission_agent_session_key" ON "approval_submission" USING btree ("agent_session_id");--> statement-breakpoint
CREATE INDEX "approval_submission_claim_idx" ON "approval_submission" USING btree ("state","next_attempt_at");