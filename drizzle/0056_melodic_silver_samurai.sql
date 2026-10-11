ALTER TABLE "retest" ALTER COLUMN "commit_sha" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "retest" ADD COLUMN "material_kind" text DEFAULT 'git' NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_intake" ADD COLUMN "connected_repository_id" uuid;--> statement-breakpoint
ALTER TABLE "upload_intake" ADD CONSTRAINT "upload_intake_connected_repository_id_connected_repository_id_fk" FOREIGN KEY ("connected_repository_id") REFERENCES "public"."connected_repository"("id") ON DELETE restrict ON UPDATE no action;