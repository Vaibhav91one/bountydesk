ALTER TABLE "session_event" ADD COLUMN "event_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "session_event_report_event_key_key" ON "session_event" USING btree ("report_id","event_key");