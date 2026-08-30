CREATE TABLE "artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"verdict_id" uuid,
	"kind" text NOT NULL,
	"storage_path" text,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_session" ADD COLUMN "final_summary" text;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_verdict_id_verdict_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdict"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_verdict_kind_key" ON "artifact" USING btree ("verdict_id","kind");--> statement-breakpoint
CREATE INDEX "artifact_report_idx" ON "artifact" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "artifact_verdict_idx" ON "artifact" USING btree ("verdict_id");--> statement-breakpoint

-- Hand-appended to the generated migration: drizzle-kit models tables, not RLS or triggers,
-- and the artifact table needs both. Same default-deny posture as every other table (0001).
ALTER TABLE "artifact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- An artifact is content-addressed evidence: its sha256 attests to bytes a reviewer can pull
-- and check. A row that could be edited after the fact would let the recorded hash describe a
-- file that no longer matches it. Same append-only guard as verdict and session_event (0001).
CREATE TRIGGER artifact_is_append_only
BEFORE UPDATE OR DELETE ON "artifact"
FOR EACH ROW EXECUTE FUNCTION bountydesk_deny_mutation();