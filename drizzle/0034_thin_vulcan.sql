CREATE TABLE "github_repository_lookup" (
	"name" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"full_name" text,
	"parent_full_name" text,
	"source_full_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_repository_lookup_state_check" CHECK ("github_repository_lookup"."state" in ('pending', 'found', 'missing', 'error'))
);
--> statement-breakpoint
ALTER TABLE "github_repository_lookup" ENABLE ROW LEVEL SECURITY;