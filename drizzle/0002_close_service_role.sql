-- BountyDesk uses the postgres connection directly. The Supabase service role has no reason to
-- reach these tables through PostgREST, and keeping that unused path open would bypass RLS.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM service_role;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM service_role;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM service_role;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON TABLES FROM service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON SEQUENCES FROM service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON FUNCTIONS FROM service_role;
  END IF;
END
$do$;
