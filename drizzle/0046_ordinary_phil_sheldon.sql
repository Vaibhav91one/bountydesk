CREATE TABLE "code_review_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"capability_token" text NOT NULL,
	"agent_session_id" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "code_review_run" ADD CONSTRAINT "code_review_run_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "code_review_run_capability_token_key" ON "code_review_run" USING btree ("capability_token");--> statement-breakpoint
CREATE INDEX "code_review_run_report_idx" ON "code_review_run" USING btree ("report_id");
--> statement-breakpoint

-- Hand-appended: same default-deny posture as every other table (0001).
ALTER TABLE "code_review_run" ENABLE ROW LEVEL SECURITY;