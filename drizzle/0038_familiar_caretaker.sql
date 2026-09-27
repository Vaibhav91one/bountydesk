ALTER TYPE "public"."intake_channel" ADD VALUE 'upload';--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "contact_code_hash" text;--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "contact_code_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "contact_code_attempts" integer DEFAULT 0 NOT NULL;