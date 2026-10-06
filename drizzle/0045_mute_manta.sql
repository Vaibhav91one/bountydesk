CREATE TABLE "code_review_finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"file" text NOT NULL,
	"line" integer,
	"category" text NOT NULL,
	"summary" text NOT NULL,
	"severity" text NOT NULL,
	"confidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "code_review_finding" ADD CONSTRAINT "code_review_finding_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_review_finding_report_idx" ON "code_review_finding" USING btree ("report_id");
--> statement-breakpoint

-- Hand-appended to the generated migration: drizzle-kit models tables, not RLS or triggers,
-- and the code_review_finding table needs both. Same default-deny posture as every other table (0001).
ALTER TABLE "code_review_finding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- A finding is append-only evidence from a read-only review: it must not be edited or deleted
-- after the fact, any more than verdict or session_event. Same append-only guard (0001).
CREATE TRIGGER code_review_finding_is_append_only
BEFORE UPDATE OR DELETE ON "code_review_finding"
FOR EACH ROW EXECUTE FUNCTION bountydesk_deny_mutation();