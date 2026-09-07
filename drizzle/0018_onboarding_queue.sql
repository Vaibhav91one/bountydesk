CREATE TABLE "target_onboarding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"repo_full_name" text NOT NULL,
	"source_ref" text NOT NULL,
	"state" text DEFAULT 'PENDING_BUILD' NOT NULL,
	"image_name" text,
	"image_digest" text,
	"snapshot_id" text,
	"build_marker" text,
	"dockerfile_text" text,
	"proposed_manifest" jsonb,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"fence" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "target_profile" ADD COLUMN "dockerfile_text" text;--> statement-breakpoint
CREATE UNIQUE INDEX "target_onboarding_repo_id_key" ON "target_onboarding" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "target_onboarding_claim_idx" ON "target_onboarding" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "target_onboarding_lease_idx" ON "target_onboarding" USING btree ("lease_expires_at");