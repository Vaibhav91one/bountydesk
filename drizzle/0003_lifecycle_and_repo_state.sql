CREATE TABLE "lifecycle_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connected_repository" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_delivery_delivery_id_key" ON "lifecycle_delivery" USING btree ("delivery_id");--> statement-breakpoint

-- Hand-appended to the generated migration: drizzle-kit models tables, not RLS or triggers,
-- and lifecycle_delivery needs both. Same default-deny posture as every other table (0001).
ALTER TABLE "lifecycle_delivery" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- This table is the replay guard. One that can be edited or deleted is not a guard.
CREATE TRIGGER lifecycle_delivery_is_append_only
BEFORE UPDATE OR DELETE ON "lifecycle_delivery"
FOR EACH ROW EXECUTE FUNCTION bountydesk_deny_mutation();
