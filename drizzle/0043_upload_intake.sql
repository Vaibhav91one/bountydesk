CREATE TABLE "upload_intake" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"sender_key" text NOT NULL,
	"sender_domain" text NOT NULL,
	"client_ip" text,
	"material_kind" text,
	"archive" "bytea",
	"source_archive_digest" text,
	"image_ref" text,
	"image_digest" text,
	"material_bytes" integer,
	"reviewed_target" jsonb,
	"approved_by" text,
	"build_state" text,
	"build_lease_expires_at" timestamp with time zone,
	"build_attempts" integer DEFAULT 0 NOT NULL,
	"build_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_intake_material_kind_check" CHECK ("upload_intake"."material_kind" is null or "upload_intake"."material_kind" in ('archive', 'dockerfile', 'image')),
	CONSTRAINT "upload_intake_build_state_check" CHECK ("upload_intake"."build_state" is null or "upload_intake"."build_state" in ('PENDING', 'BUILDING', 'BUILT', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "upload_intake" ADD CONSTRAINT "upload_intake_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "upload_intake_report_key" ON "upload_intake" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "upload_intake_created_idx" ON "upload_intake" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "upload_intake_build_state_idx" ON "upload_intake" USING btree ("build_state");--> statement-breakpoint
ALTER TABLE "upload_intake" ENABLE ROW LEVEL SECURITY;