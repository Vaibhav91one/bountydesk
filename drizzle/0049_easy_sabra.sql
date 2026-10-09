CREATE TYPE "public"."reviewer_role" AS ENUM('member', 'read_only');--> statement-breakpoint
ALTER TABLE "reviewer" ADD COLUMN "role" "reviewer_role" DEFAULT 'member' NOT NULL;