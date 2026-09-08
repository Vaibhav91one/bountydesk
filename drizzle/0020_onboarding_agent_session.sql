ALTER TABLE "target_onboarding" ADD COLUMN "agent_capability_token" text;--> statement-breakpoint
ALTER TABLE "target_onboarding" ADD COLUMN "agent_sandbox_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "target_onboarding_agent_capability_token_key" ON "target_onboarding" USING btree ("agent_capability_token");