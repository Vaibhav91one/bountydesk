ALTER TABLE "reviewer" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviewer" ADD COLUMN "code_hash" text;--> statement-breakpoint
ALTER TABLE "reviewer" ADD COLUMN "code_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviewer" ADD COLUMN "code_attempts" integer DEFAULT 0 NOT NULL;