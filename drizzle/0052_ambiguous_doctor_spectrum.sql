ALTER TABLE "upload_intake" DROP CONSTRAINT "upload_intake_material_kind_check";--> statement-breakpoint
ALTER TABLE "upload_intake" ADD COLUMN "git_url" text;--> statement-breakpoint
ALTER TABLE "upload_intake" ADD COLUMN "git_commit_sha" text;--> statement-breakpoint
ALTER TABLE "upload_intake" ADD CONSTRAINT "upload_intake_material_kind_check" CHECK ("upload_intake"."material_kind" is null or "upload_intake"."material_kind" in ('archive', 'dockerfile', 'image', 'git'));