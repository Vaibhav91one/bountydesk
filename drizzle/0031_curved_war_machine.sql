ALTER TABLE "target_profile" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
-- The one profile retired before this column existed carried the retirement only in its name.
UPDATE "target_profile" SET "retired_at" = '2026-09-06T12:03:02Z' WHERE "name" = 'dsvw-retired-20260906' AND "retired_at" IS NULL;
