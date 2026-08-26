-- Replay guard for App lifecycle webhooks.
--
-- GitHub keeps X-GitHub-Delivery when a delivery is retried or someone presses Redeliver.
-- Lifecycle handlers are upserts, so replaying one is normally harmless, with one exception
-- that is not: redelivering an old installation.created after an uninstall would clear
-- deleted_at and hand access back. The unique delivery id is what stops that.
--
-- Hand-written alongside 0001 and 0002: drizzle-kit models tables, not RLS or triggers, and
-- this table needs both.
CREATE TABLE "lifecycle_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_delivery_delivery_id_key" ON "lifecycle_delivery" USING btree ("delivery_id");
--> statement-breakpoint

-- Same default-deny posture as every other table (see 0001).
ALTER TABLE "lifecycle_delivery" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- A guard that can be edited or deleted is not a guard.
CREATE TRIGGER lifecycle_delivery_is_append_only
BEFORE UPDATE OR DELETE ON "lifecycle_delivery"
FOR EACH ROW EXECUTE FUNCTION bountydesk_deny_mutation();
