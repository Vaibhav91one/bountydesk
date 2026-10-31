-- Hand-written (drizzle-kit generate --custom): drizzle-kit models tables, not triggers.
--
-- The artifact table is evidence: sha256 attests to the bytes. 0015 made it fully append-only, but
-- recordOne writes the row after a best-effort upload, so a failed upload (Storage down, quota)
-- leaves storage_path null, and a later successful retry had no way to record where the bytes
-- landed. This relaxes the guard by exactly one transition: storage_path null -> non-null, with
-- every other column unchanged. Backfilling a path to bytes whose hash was already attested does
-- not weaken the evidence guarantee. The hash, kind, size and ownership still cannot change, a
-- set path cannot be repointed, and DELETE stays denied. RLS is untouched: the table keeps
-- default-deny from 0015.
CREATE OR REPLACE FUNCTION bountydesk_artifact_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.storage_path IS NULL
    AND NEW.storage_path IS NOT NULL
    AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.report_id IS NOT DISTINCT FROM OLD.report_id
    AND NEW.verdict_id IS NOT DISTINCT FROM OLD.verdict_id
    AND NEW.kind IS NOT DISTINCT FROM OLD.kind
    AND NEW.sha256 IS NOT DISTINCT FROM OLD.sha256
    AND NEW.bytes IS NOT DISTINCT FROM OLD.bytes
    AND NEW.content_type IS NOT DISTINCT FROM OLD.content_type
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$fn$;--> statement-breakpoint

DROP TRIGGER artifact_is_append_only ON "artifact";--> statement-breakpoint
CREATE TRIGGER artifact_is_append_only
BEFORE UPDATE OR DELETE ON "artifact"
FOR EACH ROW EXECUTE FUNCTION bountydesk_artifact_guard();
