CREATE TABLE "device_push_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reviewer_email" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_push_token_token_unique" UNIQUE("token"),
	CONSTRAINT "device_push_token_platform_check" CHECK ("device_push_token"."platform" in ('ios', 'android'))
);
--> statement-breakpoint
CREATE TABLE "notification_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_event_report_kind_ref_key" UNIQUE("report_id","kind","ref_id"),
	CONSTRAINT "notification_event_kind_check" CHECK ("notification_event"."kind" in ('AWAITING_APPROVAL', 'DELIVERED'))
);
--> statement-breakpoint
ALTER TABLE "notification_event" ADD CONSTRAINT "notification_event_report_id_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- notification_event is keyed by (report_id, kind, ref_id); a notification that already went out
-- must never be edited or deleted, so a second sweep is a no-op rather than a resend.
CREATE TRIGGER notification_event_is_append_only
BEFORE UPDATE OR DELETE ON "notification_event"
FOR EACH ROW EXECUTE FUNCTION bountydesk_deny_mutation();