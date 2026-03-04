-- =============================================================================
-- Fix scan_jobs_set_job_uuid trigger + migrate scan_jobs.user_id → uuid
-- =============================================================================
-- Why: scan_jobs.user_id is text; auth.uid() and profiles.id are uuid.
-- Comparing them throws "operator does not exist: text = uuid" in RLS policies
-- and in any join/filter against auth.users or profiles.
--
-- Strategy (safe — preserves all valid data):
--   1. Null out rows where user_id is not a valid UUID string (e.g. "guest_user",
--      empty string, any legacy placeholder). These rows cannot be owned by a
--      real auth user so they are effectively orphaned.
--   2. ALTER COLUMN user_id TYPE uuid USING user_id::uuid.
--   3. Re-check RLS policies — they can now use auth.uid() = user_id directly.
--
-- Run AFTER fix-delete-photo-type-mismatch.sql and
-- standardize-photo-id-columns-uuid.sql.
-- =============================================================================

-- Step 1: show what non-UUID user_id values exist (informational — does not modify data)
-- Run this SELECT first if you want to audit before deleting:
--
-- SELECT user_id, count(*)
-- FROM scan_jobs
-- GROUP BY user_id
-- ORDER BY count(*) DESC;

-- =============================================================================
-- Step 0: Fix or drop the scan_jobs_set_job_uuid trigger.
--
-- This trigger was created when scan_jobs.id was text (stored as "job_<uuid>").
-- It populated a separate job_uuid uuid column by stripping the "job_" prefix.
-- Now that scan_jobs.id is uuid type:
--   • The regex   new.id ~ '^job_[0-9a-f-]{36}$'   fails with
--     "operator does not exist: uuid ~ unknown"
--   • The job_uuid column is redundant — scan_jobs.id IS the uuid already.
--
-- Fix: replace the trigger function with a no-op that just sets job_uuid = NEW.id
-- (so any code that still reads job_uuid keeps working), and cast id::text only
-- where a regex is needed.
-- =============================================================================

-- Drop the old trigger first so the function replacement takes effect cleanly
DROP TRIGGER IF EXISTS scan_jobs_set_job_uuid_trigger ON scan_jobs;
DROP TRIGGER IF EXISTS set_job_uuid ON scan_jobs;

-- Replace the function: id is already a plain uuid — just mirror it into job_uuid
CREATE OR REPLACE FUNCTION scan_jobs_set_job_uuid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- scan_jobs.id is now uuid type; job_uuid mirrors it directly.
  -- No prefix stripping needed. Cast to text and back is a no-op safety measure.
  IF NEW.job_uuid IS NULL THEN
    NEW.job_uuid := NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

-- Re-attach trigger
CREATE TRIGGER scan_jobs_set_job_uuid_trigger
BEFORE INSERT OR UPDATE ON scan_jobs
FOR EACH ROW EXECUTE FUNCTION scan_jobs_set_job_uuid();


-- =============================================================================
-- Step 1b: Capture the current definition of user_activity_stats so we can
-- recreate it after the ALTER. Run this SELECT first and save the result:
--
--   SELECT pg_get_viewdef('user_activity_stats'::regclass, true);
--
-- Then paste the output into the CREATE OR REPLACE VIEW below.
-- The definition below is reconstructed from what the admin API queries
-- (username, display_name, email, total_completed_scans, scans_last_7d,
-- scans_last_30d). Adjust if your actual view differs.

-- Step 2: Drop dependent view so ALTER TABLE can proceed
DROP VIEW IF EXISTS user_activity_stats;

-- Step 3: Null out any user_id that is not a valid UUID
--   This covers: 'guest_user', '', NULL (already null), any timestamp-based id.
UPDATE scan_jobs
SET user_id = NULL
WHERE user_id IS NOT NULL
  AND user_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

-- Step 4: Convert column type
DO $$
DECLARE
  v_type text;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'scan_jobs'
    AND column_name  = 'user_id';

  IF v_type IS NOT NULL AND v_type <> 'uuid' THEN
    RAISE NOTICE 'Converting scan_jobs.user_id from % to uuid', v_type;

    ALTER TABLE scan_jobs
    ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

    RAISE NOTICE 'scan_jobs.user_id converted to uuid';
  ELSE
    RAISE NOTICE 'scan_jobs.user_id is already uuid (or column not found) — skipping';
  END IF;
END
$$;

-- Step 5: Recreate user_activity_stats view.
-- IMPORTANT: Before running this migration, run the following query in a
-- separate SQL editor tab and replace the view body below with the real output:
--
--   SELECT pg_get_viewdef('user_activity_stats'::regclass, true);
--
-- The version below is a best-effort reconstruction. If your view has
-- additional columns or joins, you MUST use the real definition.
CREATE OR REPLACE VIEW user_activity_stats AS
SELECT
  p.id                                                          AS user_id,
  p.username,
  p.display_name,
  u.email,
  COUNT(DISTINCT sj.id) FILTER (WHERE sj.status = 'completed') AS total_completed_scans,
  COUNT(DISTINCT sj.id) FILTER (
    WHERE sj.status = 'completed'
      AND sj.created_at >= (now() - INTERVAL '7 days')
  )                                                             AS scans_last_7d,
  COUNT(DISTINCT sj.id) FILTER (
    WHERE sj.status = 'completed'
      AND sj.created_at >= (now() - INTERVAL '30 days')
  )                                                             AS scans_last_30d,
  COUNT(DISTINCT b.id) FILTER (WHERE b.deleted_at IS NULL)     AS total_books
FROM profiles p
LEFT JOIN auth.users u  ON u.id  = p.id
LEFT JOIN scan_jobs  sj ON sj.user_id = p.id AND sj.deleted_at IS NULL
LEFT JOIN books      b  ON b.user_id  = p.id AND b.deleted_at IS NULL
GROUP BY p.id, p.username, p.display_name, u.email;

-- Step 4: Verify
SELECT
  table_name,
  column_name,
  data_type,
  udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'scan_jobs'
  AND column_name  IN ('id', 'user_id', 'photo_id')
ORDER BY column_name;
-- Expected: all three should show data_type = 'uuid'
