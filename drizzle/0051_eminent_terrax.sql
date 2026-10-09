CREATE TABLE "appeal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"verdict_id" uuid NOT NULL,
	"body" text NOT NULL,
	"contact" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"resolution_note" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appeal_status_check" CHECK ("appeal"."status" in ('OPEN', 'ACKNOWLEDGED', 'CLOSED')),
	CONSTRAINT "appeal_body_length_check" CHECK (char_length("appeal"."body") between 1 and 4000)
);
--> statement-breakpoint
CREATE TABLE "appeal_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"contact" text NOT NULL,
	"code_hash" text,
	"expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"client_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_report_verdict_fk" FOREIGN KEY ("report_id","verdict_id") REFERENCES "public"."verdict"("report_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appeal_active_verdict_key" ON "appeal" USING btree ("verdict_id") WHERE "appeal"."status" <> 'CLOSED';--> statement-breakpoint
CREATE INDEX "appeal_report_idx" ON "appeal" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE INDEX "appeal_code_report_idx" ON "appeal_code" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE INDEX "appeal_code_ip_idx" ON "appeal_code" USING btree ("client_ip","created_at");