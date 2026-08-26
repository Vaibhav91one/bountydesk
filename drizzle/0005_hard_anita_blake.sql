-- One row per logical target profile.
--
-- The unique index is the point of this migration, but it cannot simply be created:
-- target_profile.name had no constraint until now, and the seeder that existed before this
-- change used an unqualified ON CONFLICT DO NOTHING, which on a table whose only unique
-- column is the generated primary key never conflicts. Running it twice therefore left two
-- rows named juice-shop-v17.3.0, and CREATE UNIQUE INDEX would fail on exactly the databases
-- someone had been developing against.
--
-- So: refuse to guess where guessing is dangerous, consolidate where it is not, then index.

-- Duplicates that disagree about what they pin are not duplicates, they are two different
-- targets wearing one name. Picking a winner would silently repoint reports at a target
-- nobody chose, which is the one thing scope binding exists to prevent. Stop and say so.
DO $do$
DECLARE
  conflicting text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name)
    INTO conflicting
    FROM (
      SELECT name
        FROM target_profile
       GROUP BY name
      HAVING count(*) > 1
         AND count(DISTINCT (
               image_digest,
               coalesce(snapshot_id, ''),
               config::text,
               scope_rules::text
             )) > 1
    ) AS disagreeing;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'target_profile has duplicate names whose pinned settings differ: %. Decide which row is correct and delete the others before migrating.',
      conflicting
      USING ERRCODE = 'unique_violation';
  END IF;
END
$do$;
--> statement-breakpoint

-- What is left is byte-identical duplicates, which are safe to collapse onto the oldest row.
-- The mapping is recomputed in each statement rather than held in a temp table: drizzle runs
-- a migration inside one transaction, but the test harness replays the statements one at a
-- time, and a temp table declared ON COMMIT DROP would not survive that.
UPDATE connected_repository c
   SET target_profile_id = k.keep_id
  FROM (
        SELECT id,
               first_value(id) OVER (PARTITION BY name ORDER BY created_at, id) AS keep_id
          FROM target_profile
       ) k
 WHERE c.target_profile_id = k.id
   AND k.id <> k.keep_id;
--> statement-breakpoint

UPDATE report r
   SET target_profile_id = k.keep_id
  FROM (
        SELECT id,
               first_value(id) OVER (PARTITION BY name ORDER BY created_at, id) AS keep_id
          FROM target_profile
       ) k
 WHERE r.target_profile_id = k.id
   AND k.id <> k.keep_id;
--> statement-breakpoint

DELETE FROM target_profile t
 USING (
        SELECT id,
               first_value(id) OVER (PARTITION BY name ORDER BY created_at, id) AS keep_id
          FROM target_profile
       ) k
 WHERE t.id = k.id
   AND k.id <> k.keep_id;
--> statement-breakpoint

CREATE UNIQUE INDEX "target_profile_name_key" ON "target_profile" USING btree ("name");
