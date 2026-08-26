-- Security hardening. Hand-written: drizzle-kit models tables, not grants, RLS or triggers.
--
-- Two separate problems are addressed here.
--
--   1. Supabase auto-exposes every table in `public` through PostgREST, and by default grants
--      anon and authenticated full DML on them. Nothing in this application is meant to be
--      reachable from a browser: all access goes through the server as the `postgres` role.
--      So the Data API is closed off entirely rather than policy-tuned. Today the anon key
--      never leaves the server, but "the credential has not leaked yet" is not access control.
--
--   2. Several tables are described as immutable or append-only. A comment is not an
--      enforcement mechanism. These are the tables the approval gate and the audit trail rest
--      on, so the database refuses the writes itself.

--> statement-breakpoint

-- 1. Close the Data API ------------------------------------------------------------------
--
-- `anon` and `authenticated` are Supabase's roles, not Postgres ones: they do not exist on
-- the plain server CI and worktree-isolated agents run against. Guarding on the role means
-- the same migration applies in both places instead of needing a Supabase-only variant.
DO $do$
DECLARE
  target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', target_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', target_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', target_role);
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', target_role);

      -- Future tables inherit the lockout, so one added later is not quietly world-writable.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', target_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', target_role
      );
    END IF;
  END LOOP;
END
$do$;
--> statement-breakpoint

-- Defence in depth. With RLS on and no policies defined, every role is denied by default.
-- The `postgres` role we connect as has BYPASSRLS, so the application is unaffected; this
-- exists so that a future grant, or a policy added by mistake, still has to get past RLS.
ALTER TABLE "approval_decision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connected_repository" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delivery_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "github_installation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inbound_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbound_delivery" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "target_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "verdict" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- 2. Make immutability real --------------------------------------------------------------

CREATE OR REPLACE FUNCTION bountydesk_deny_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION
    '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$fn$;
--> statement-breakpoint

-- A verdict is the artifact a human approves by content hash. If the row could be edited
-- after approval, the hash would attest to text that no longer exists. Revising a verdict
-- means inserting the next revision, which is why (report_id, revision) is unique.
CREATE TRIGGER verdict_is_immutable
BEFORE UPDATE OR DELETE ON "verdict"
FOR EACH ROW EXECUTE FUNCTION bountydesk_deny_mutation();
--> statement-breakpoint

-- A human decision is a fact about a moment. It is never amended.
CREATE TRIGGER approval_decision_is_immutable
BEFORE UPDATE OR DELETE ON "approval_decision"
FOR EACH ROW EXECUTE FUNCTION bountydesk_deny_mutation();
--> statement-breakpoint

-- The audit trail. Deleting from it is the first thing an attacker would want to do.
CREATE TRIGGER session_event_is_append_only
BEFORE UPDATE OR DELETE ON "session_event"
FOR EACH ROW EXECUTE FUNCTION bountydesk_deny_mutation();
--> statement-breakpoint

-- What actually happened on each delivery attempt, for incident review.
CREATE TRIGGER delivery_attempt_is_append_only
BEFORE UPDATE OR DELETE ON "delivery_attempt"
FOR EACH ROW EXECUTE FUNCTION bountydesk_deny_mutation();
