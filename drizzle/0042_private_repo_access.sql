ALTER TABLE "connected_repository" ADD COLUMN "is_private" boolean;--> statement-breakpoint
ALTER TABLE "github_installation" ADD COLUMN "contents_permission" text;