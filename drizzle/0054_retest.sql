CREATE TABLE "retest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_report_id" uuid NOT NULL,
	"original_verdict_id" uuid NOT NULL,
	"child_report_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retest" ADD CONSTRAINT "retest_original_report_id_report_id_fk" FOREIGN KEY ("original_report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retest" ADD CONSTRAINT "retest_original_verdict_id_verdict_id_fk" FOREIGN KEY ("original_verdict_id") REFERENCES "public"."verdict"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retest" ADD CONSTRAINT "retest_child_report_id_report_id_fk" FOREIGN KEY ("child_report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retest" ADD CONSTRAINT "retest_original_report_verdict_fk" FOREIGN KEY ("original_report_id","original_verdict_id") REFERENCES "public"."verdict"("report_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retest_child_report_id_key" ON "retest" USING btree ("child_report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retest_verdict_commit_key" ON "retest" USING btree ("original_verdict_id","commit_sha");--> statement-breakpoint
CREATE INDEX "retest_original_report_idx" ON "retest" USING btree ("original_report_id");--> statement-breakpoint
ALTER TABLE "retest" ENABLE ROW LEVEL SECURITY;
