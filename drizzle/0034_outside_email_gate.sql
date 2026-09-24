ALTER TYPE "public"."report_lifecycle_state" ADD VALUE 'NEEDS_DECISION' BEFORE 'REPRODUCING';--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "verified_sender" text;--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "duplicate_of_report_id" uuid;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_duplicate_of_report_id_report_id_fk" FOREIGN KEY ("duplicate_of_report_id") REFERENCES "public"."report"("id") ON DELETE no action ON UPDATE no action;