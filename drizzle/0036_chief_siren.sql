CREATE TABLE "outside_intake_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"per_sender_per_day" integer NOT NULL,
	"per_domain_per_day" integer NOT NULL,
	"max_bytes" integer NOT NULL,
	"exempt_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
