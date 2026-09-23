ALTER TABLE "connected_repository" ADD COLUMN "parent_full_name" text;--> statement-breakpoint
ALTER TABLE "connected_repository" ADD COLUMN "source_full_name" text;--> statement-breakpoint
CREATE INDEX "connected_repository_parent_idx" ON "connected_repository" USING btree (lower("parent_full_name"));--> statement-breakpoint
CREATE INDEX "connected_repository_source_idx" ON "connected_repository" USING btree (lower("source_full_name"));