ALTER TABLE "outbound_delivery" ADD COLUMN "max_attempts" integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_delivery" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "outbound_delivery" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbound_delivery" ADD COLUMN "fence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_delivery" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "outbound_delivery_claim_idx" ON "outbound_delivery" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbound_delivery_lease_idx" ON "outbound_delivery" USING btree ("lease_expires_at");