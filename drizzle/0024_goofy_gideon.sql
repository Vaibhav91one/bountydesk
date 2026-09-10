ALTER TABLE "agent_session" ADD COLUMN "sandbox_ids" jsonb;--> statement-breakpoint
ALTER TABLE "target_onboarding" ADD COLUMN "resolved_commit_sha" text;--> statement-breakpoint
ALTER TABLE "target_onboarding" ADD COLUMN "source_archive_digest" text;--> statement-breakpoint
ALTER TABLE "target_onboarding" ADD COLUMN "build_recipe_digest" text;--> statement-breakpoint
ALTER TABLE "target_profile" ADD COLUMN "build_recipe_digest" text;--> statement-breakpoint
ALTER TABLE "target_profile" ADD COLUMN "resolved_commit_sha" text;--> statement-breakpoint
ALTER TABLE "target_profile" ADD COLUMN "source_archive_digest" text;