-- =============================================================================
-- duplicate_index (WARN): Remove redundant index on public.cover_resolutions
-- =============================================================================
-- Keep the primary key index; drop any other index that has the same key columns.
-- If the duplicate is two non-pkey indexes (e.g. both on work_key), run the audit
-- query and drop the redundant one by name (e.g. DROP INDEX ... cover_resolutions_work_key_idx;).
--
-- Audit (run before/after to confirm):
--   \d public.cover_resolutions
--   select indexname, indexdef from pg_indexes
--   where schemaname='public' and tablename='cover_resolutions';
-- =============================================================================

DO $$
DECLARE
  pkey_indkey int2vector;
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'cover_resolutions') THEN
    RETURN;
  END IF;

  SELECT i.indkey INTO pkey_indkey
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE t.relname = 'cover_resolutions'
    AND n.nspname = 'public'
    AND i.indisprimary;

  IF pkey_indkey IS NULL THEN
    RETURN;
  END IF;

  -- Drop any non-primary index with the same key columns as the pkey.
  FOR r IN
    SELECT i.indexrelid::regclass AS idxname
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'cover_resolutions'
      AND n.nspname = 'public'
      AND NOT i.indisprimary
      AND i.indkey = pkey_indkey
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %s', r.idxname);
  END LOOP;
END $$;
