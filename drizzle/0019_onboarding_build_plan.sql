ALTER TABLE "target_onboarding" ALTER COLUMN "state" SET DEFAULT 'PENDING_PLAN';--> statement-breakpoint
ALTER TABLE "target_onboarding" ADD COLUMN "build_plan" jsonb;