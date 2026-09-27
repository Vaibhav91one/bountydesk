CREATE TABLE "outside_intake_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"per_sender_per_day" integer NOT NULL,
	"per_domain_per_day" integer NOT NULL,
	"max_bytes" integer NOT NULL,
	"exempt_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "outside_intake_config_singleton" CHECK ("outside_intake_config"."id" = 1)
);
