CREATE TABLE "agent_session_claim" (
	"report_id" uuid PRIMARY KEY NOT NULL,
	"claim_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_session_claim" ADD CONSTRAINT "agent_session_claim_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_session_claim_expires_idx" ON "agent_session_claim" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "agent_session_claim" ENABLE ROW LEVEL SECURITY;
