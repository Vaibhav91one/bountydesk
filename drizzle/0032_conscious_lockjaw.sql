CREATE TABLE "owner_advisory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"verdict_id" uuid NOT NULL,
	"connected_repository_id" uuid NOT NULL,
	"approved_content_hash" text NOT NULL,
	"requested_by" text NOT NULL,
	"state" "delivery_state" DEFAULT 'PENDING' NOT NULL,
	"ghsa_id" text,
	"html_url" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "owner_advisory" ADD CONSTRAINT "owner_advisory_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_advisory" ADD CONSTRAINT "owner_advisory_verdict_id_verdict_id_fk" FOREIGN KEY ("verdict_id") REFERENCES "public"."verdict"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_advisory" ADD CONSTRAINT "owner_advisory_connected_repository_id_connected_repository_id_fk" FOREIGN KEY ("connected_repository_id") REFERENCES "public"."connected_repository"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owner_advisory_report_key" ON "owner_advisory" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "owner_advisory_claim_idx" ON "owner_advisory" USING btree ("state","next_attempt_at");--> statement-breakpoint
ALTER TABLE "owner_advisory" ENABLE ROW LEVEL SECURITY;
