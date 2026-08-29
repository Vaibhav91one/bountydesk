CREATE TYPE "public"."scope_guard_audit_verdict" AS ENUM('allowed', 'denied', 'mutated');--> statement-breakpoint
CREATE TABLE "scope_guard_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"auth" text NOT NULL,
	"action" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verdict" "scope_guard_audit_verdict" NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scope_guard_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"target" text NOT NULL,
	"action" text NOT NULL,
	"event" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scope_guard_grant_event_check" CHECK ("scope_guard_grant"."event" in ('issued', 'consumed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scope_guard_audit_seq_key" ON "scope_guard_audit" USING btree ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "scope_guard_audit_hash_key" ON "scope_guard_audit" USING btree ("hash");--> statement-breakpoint
CREATE UNIQUE INDEX "scope_guard_grant_token_issued_key" ON "scope_guard_grant" USING btree ("token") WHERE "scope_guard_grant"."event" = 'issued';--> statement-breakpoint
CREATE UNIQUE INDEX "scope_guard_grant_token_consumed_key" ON "scope_guard_grant" USING btree ("token") WHERE "scope_guard_grant"."event" = 'consumed';--> statement-breakpoint
CREATE INDEX "scope_guard_grant_token_idx" ON "scope_guard_grant" USING btree ("token");
-- Hand-appended to the generated migration: drizzle-kit models tables, not RLS or triggers.
-- Same default-deny posture as every other table (0001), and the same insert-only guard as
-- verdict/approval_decision/session_event/delivery_attempt.
ALTER TABLE "scope_guard_audit" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "scope_guard_grant" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The hash-chained audit trail. Deleting or rewriting an entry is the first thing an attacker
-- would want to do after abusing scope-guard; the chain (prev_hash/hash) makes that tamper
-- evident even against direct SQL access, but only if the row underneath it truly cannot move.
CREATE TRIGGER scope_guard_audit_is_append_only
BEFORE UPDATE OR DELETE ON "scope_guard_audit"
FOR EACH ROW EXECUTE FUNCTION bountydesk_deny_mutation();
--> statement-breakpoint

-- Grants are consumed by inserting a matching "consumed" row (see lib/scope-guard/grants.ts),
-- never by updating the "issued" row - this trigger is what makes that the only option, which
-- is what keeps a single-use grant from being quietly reset to unused.
CREATE TRIGGER scope_guard_grant_is_append_only
BEFORE UPDATE OR DELETE ON "scope_guard_grant"
FOR EACH ROW EXECUTE FUNCTION bountydesk_deny_mutation();
