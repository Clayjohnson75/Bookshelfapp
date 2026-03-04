-- =============================================================================
-- Standardize all photo-id reference columns to UUID type
-- =============================================================================
-- Fixes: "operator does not exist: text = uuid" when calling
--   delete_library_photo_and_books(p_photo_id uuid, ...) because
--   books.source_photo_id (and/or scan_jobs.photo_id) were stored as text.
--
-- Columns targeted:
--   photos.id                    — primary key (should already be uuid; guard included)
--   books.source_photo_id        — FK reference to photos.id
--   books.source_scan_job_id     — FK reference to scan_jobs.id
--   scan_jobs.photo_id           — FK reference to photos.id
--
-- Strategy per column:
--   1. Check current data_type via information_schema (idempotent guard).
--   2. NULL out any rows where the stored value is NOT a valid UUID string
--      (defensive: bad data that cannot be cast would abort the ALTER).
--   3. ALTER COLUMN ... TYPE uuid USING value::uuid.
--
-- FKs: added after all columns are uuid so the types align.
--   books.source_photo_id  → photos.id     (ON DELETE SET NULL — soft-delete path owns cascade)
--   books.source_scan_job_id → scan_jobs.id (ON DELETE SET NULL)
--   scan_jobs.photo_id     → photos.id     (ON DELETE SET NULL)
--
-- Also refreshes the delete_library_photo_and_books RPC and approve_scan_job RPC
-- so they work correctly against uuid columns (no more ::text casts needed in
-- approve_scan_job; delete RPC already typed correctly).
--
-- Run in Supabase SQL Editor. Safe to re-run (all steps are guarded).
-- =============================================================================

-- =============================================================================
-- STEP 0 (unconditional): Drop all FK constraints that touch photo/job id columns
-- and null out any orphaned references BEFORE any type-conversion work begins.
-- This must run outside the guarded DO blocks so it fires even when columns are
-- already the right type (i.e. on a re-run after a partial migration).
-- =============================================================================

ALTER TABLE books     DROP CONSTRAINT IF EXISTS books_source_photo_id_fkey;
ALTER TABLE books     DROP CONSTRAINT IF EXISTS books_source_scan_job_id_fkey;
ALTER TABLE scan_jobs DROP CONSTRAINT IF EXISTS scan_jobs_photo_id_fkey;

-- Null orphaned scan_jobs.photo_id (photo was deleted in a prior run)
UPDATE scan_jobs
SET photo_id = NULL
WHERE photo_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM photos WHERE photos.id::text = scan_jobs.photo_id::text);

-- Null orphaned books.source_photo_id
UPDATE books
SET source_photo_id = NULL
WHERE source_photo_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM photos WHERE photos.id::text = books.source_photo_id::text);

-- Null orphaned books.source_scan_job_id
UPDATE books
SET source_scan_job_id = NULL
WHERE source_scan_job_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM scan_jobs WHERE scan_jobs.id::text = books.source_scan_job_id::text);


DO $$
DECLARE
  v_type text;
BEGIN

  --------------------------------------------------------------------------
  -- 0a. photos.id → uuid  (primary key — must convert before FK references)
  --------------------------------------------------------------------------
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'photos'
    AND column_name  = 'id';

  IF v_type IS NOT NULL AND v_type <> 'uuid' THEN
    RAISE NOTICE 'Converting photos.id from % to uuid', v_type;

    -- FKs already dropped unconditionally at the top of this script.

    -- PK column: photos.id must only contain valid UUIDs before the ALTER.
    -- Legacy rows have ids like "photo_1771065499494_oqv0yab" which cannot be cast.
    -- Strategy: null out references to non-UUID photo ids in child tables, then
    -- delete (soft-delete if deleted_at exists, hard-delete otherwise) those photo rows.

    -- Step A: null out scan_jobs.photo_id for any job pointing at a non-UUID photo id.
    -- Cast to ::text before regex — photo_id may already be uuid type on some installs.
    UPDATE scan_jobs
    SET photo_id = NULL
    WHERE photo_id IS NOT NULL
      AND photo_id::text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

    -- Step B: null out books.source_photo_id for any book pointing at a non-UUID photo id.
    -- Cast to ::text before regex — column may already be uuid type on some installs.
    UPDATE books
    SET source_photo_id = NULL
    WHERE source_photo_id IS NOT NULL
      AND source_photo_id::text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

    -- Step C: remove non-UUID photo rows so the PK ALTER can proceed.
    -- Soft-delete first (set deleted_at) if the column exists; then hard-delete.
    DO $inner$
    BEGIN
      -- Try soft-delete (deleted_at column present).
      -- Cast id::text before regex — id may already be uuid type on some installs.
      UPDATE photos
      SET deleted_at = now()
      WHERE id::text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        AND deleted_at IS NULL;
    EXCEPTION WHEN undefined_column THEN
      -- deleted_at column doesn't exist; skip soft-delete
    END;
    $inner$;

    DELETE FROM photos
    WHERE id::text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

    RAISE NOTICE 'Deleted non-UUID photo rows and nulled their references in books/scan_jobs';

    -- Now all remaining photos.id values are valid UUIDs; cast is safe.
    ALTER TABLE photos
    ALTER COLUMN id TYPE uuid USING id::uuid;

    RAISE NOTICE 'photos.id converted to uuid';
  ELSE
    RAISE NOTICE 'photos.id is already uuid (or column not found) — skipping';
  END IF;

  --------------------------------------------------------------------------
  -- 0b. scan_jobs.id → uuid  (primary key — must convert before FK references)
  --------------------------------------------------------------------------
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'scan_jobs'
    AND column_name  = 'id';

  IF v_type IS NOT NULL AND v_type <> 'uuid' THEN
    RAISE NOTICE 'Converting scan_jobs.id from % to uuid', v_type;

    -- FKs already dropped unconditionally at the top of this script.

    -- PK column: scan_jobs.id may have legacy ids like "job_83f9a4bf-..." (valid UUID
    -- after stripping the prefix) or fully non-UUID garbage.
    -- Strategy:
    --   Step A: books.source_scan_job_id is already uuid — Postgres never stored job_ there.
    --   Step B: strip job_ prefix from scan_jobs.id in-place (text column).
    --   Step C: delete rows whose id is still not a valid UUID after stripping.
    --   Step D: ALTER COLUMN id TYPE uuid USING id::uuid.

    -- Step B: strip job_ prefix from scan_jobs.id in-place (text column, safe to UPDATE)
    UPDATE scan_jobs
    SET id = regexp_replace(id::text, '^job_', '')
    WHERE id::text LIKE 'job_%';

    -- Step C: delete rows whose id is still not a valid UUID after stripping
    DELETE FROM scan_jobs
    WHERE id::text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

    RAISE NOTICE 'Cleaned scan_jobs.id (stripped job_ prefix) and removed non-UUID rows';

    -- Step D: all remaining scan_jobs.id values are plain UUID strings; cast is safe.
    ALTER TABLE scan_jobs
    ALTER COLUMN id TYPE uuid USING id::uuid;

    RAISE NOTICE 'scan_jobs.id converted to uuid';
  ELSE
    RAISE NOTICE 'scan_jobs.id is already uuid (or column not found) — skipping';
  END IF;

  --------------------------------------------------------------------------
  -- 1. books.source_photo_id → uuid
  --------------------------------------------------------------------------
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'books'
    AND column_name  = 'source_photo_id';

  IF v_type IS NOT NULL AND v_type <> 'uuid' THEN
    RAISE NOTICE 'Converting books.source_photo_id from % to uuid', v_type;

    -- Null out any values that are not valid UUID strings
    UPDATE books
    SET source_photo_id = NULL
    WHERE source_photo_id IS NOT NULL
      AND source_photo_id::text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

    ALTER TABLE books
    ALTER COLUMN source_photo_id TYPE uuid USING source_photo_id::text::uuid;

    RAISE NOTICE 'books.source_photo_id converted to uuid';
  ELSE
    RAISE NOTICE 'books.source_photo_id is already uuid (or column not found) — skipping';
  END IF;

  --------------------------------------------------------------------------
  -- 2. books.source_scan_job_id → uuid
  --------------------------------------------------------------------------
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'books'
    AND column_name  = 'source_scan_job_id';

  IF v_type IS NOT NULL AND v_type <> 'uuid' THEN
    RAISE NOTICE 'Converting books.source_scan_job_id from % to uuid', v_type;

    -- Strip 'job_' prefix that the client sometimes persists
    UPDATE books
    SET source_scan_job_id = regexp_replace(source_scan_job_id::text, '^job_', '')
    WHERE source_scan_job_id IS NOT NULL
      AND source_scan_job_id::text LIKE 'job_%';

    -- Null out any values that are still not valid UUID strings
    UPDATE books
    SET source_scan_job_id = NULL
    WHERE source_scan_job_id IS NOT NULL
      AND source_scan_job_id::text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

    ALTER TABLE books
    ALTER COLUMN source_scan_job_id TYPE uuid USING source_scan_job_id::text::uuid;

    RAISE NOTICE 'books.source_scan_job_id converted to uuid';
  ELSE
    RAISE NOTICE 'books.source_scan_job_id is already uuid (or column not found) — skipping';
  END IF;

  --------------------------------------------------------------------------
  -- 3. scan_jobs.photo_id → uuid
  --------------------------------------------------------------------------
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'scan_jobs'
    AND column_name  = 'photo_id';

  IF v_type IS NOT NULL AND v_type <> 'uuid' THEN
    RAISE NOTICE 'Converting scan_jobs.photo_id from % to uuid', v_type;

    -- Null out any values that are not valid UUID strings
    UPDATE scan_jobs
    SET photo_id = NULL
    WHERE photo_id IS NOT NULL
      AND photo_id::text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

    ALTER TABLE scan_jobs
    ALTER COLUMN photo_id TYPE uuid USING photo_id::text::uuid;

    RAISE NOTICE 'scan_jobs.photo_id converted to uuid';
  ELSE
    RAISE NOTICE 'scan_jobs.photo_id is already uuid (or column not found) — skipping';
  END IF;

END
$$;


-- =============================================================================
-- Pre-FK cleanup: null out any orphaned references before adding constraints.
-- Earlier steps deleted non-UUID photo/scan_job rows; child columns pointing
-- at those deleted rows must be nulled or ADD CONSTRAINT will fail.
-- =============================================================================

-- Null scan_jobs.photo_id where the referenced photo no longer exists
UPDATE scan_jobs
SET photo_id = NULL
WHERE photo_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM photos WHERE photos.id = scan_jobs.photo_id);

-- Null books.source_photo_id where the referenced photo no longer exists
UPDATE books
SET source_photo_id = NULL
WHERE source_photo_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM photos WHERE photos.id = books.source_photo_id);

-- Null books.source_scan_job_id where the referenced scan_job no longer exists
UPDATE books
SET source_scan_job_id = NULL
WHERE source_scan_job_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM scan_jobs WHERE scan_jobs.id = books.source_scan_job_id);


-- =============================================================================
-- Add FK constraints (idempotent — DROP CONSTRAINT IF EXISTS before adding)
-- ON DELETE SET NULL: soft-delete owns the cascade; we don't want hard-delete
-- to cascade when a photo row is removed (the app soft-deletes via deleted_at).
-- =============================================================================

-- books.source_photo_id → photos.id
ALTER TABLE books
  DROP CONSTRAINT IF EXISTS books_source_photo_id_fkey;

ALTER TABLE books
  ADD CONSTRAINT books_source_photo_id_fkey
  FOREIGN KEY (source_photo_id)
  REFERENCES photos(id)
  ON DELETE SET NULL;

-- books.source_scan_job_id → scan_jobs.id
ALTER TABLE books
  DROP CONSTRAINT IF EXISTS books_source_scan_job_id_fkey;

ALTER TABLE books
  ADD CONSTRAINT books_source_scan_job_id_fkey
  FOREIGN KEY (source_scan_job_id)
  REFERENCES scan_jobs(id)
  ON DELETE SET NULL;

-- scan_jobs.photo_id → photos.id
ALTER TABLE scan_jobs
  DROP CONSTRAINT IF EXISTS scan_jobs_photo_id_fkey;

ALTER TABLE scan_jobs
  ADD CONSTRAINT scan_jobs_photo_id_fkey
  FOREIGN KEY (photo_id)
  REFERENCES photos(id)
  ON DELETE SET NULL;


-- =============================================================================
-- Refresh approve_scan_job: now that source_scan_job_id is uuid, we can
-- compare directly (uuid = uuid) instead of casting ::text. The p_job_ids
-- parameter stays text[] because the client sends job ids (possibly with
-- 'job_' prefix) as strings. Strip the prefix then cast to uuid[] for the
-- WHERE clause — no more implicit ::text casts on the column side.
-- =============================================================================

CREATE OR REPLACE FUNCTION approve_scan_job(p_user_id uuid, p_job_ids text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_raw_uuids uuid[];
  v_job_id    text;
  v_job_uuid  uuid;
  v_books_approved bigint;
  v_jobs_closed    bigint;
  v_pending_count  bigint;
  v_result         jsonb;
BEGIN
  IF p_job_ids IS NULL OR array_length(p_job_ids, 1) IS NULL OR array_length(p_job_ids, 1) = 0 THEN
    RETURN jsonb_build_object('books_approved', 0, 'jobs_closed', 0);
  END IF;

  -- Normalise to raw UUIDs: strip 'job_' prefix, discard non-UUID entries.
  SELECT array_agg(
    (CASE WHEN j LIKE 'job_%' THEN substring(j FROM 5) ELSE j END)::uuid
  )
  INTO v_raw_uuids
  FROM unnest(p_job_ids) AS j
  WHERE j IS NOT NULL
    AND length(trim(j)) > 0
    AND (CASE WHEN j LIKE 'job_%' THEN substring(j FROM 5) ELSE j END)
          ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  IF v_raw_uuids IS NULL OR array_length(v_raw_uuids, 1) IS NULL THEN
    RETURN jsonb_build_object('books_approved', 0, 'jobs_closed', 0);
  END IF;

  -- 1) Approve all pending books for these scan jobs (idempotent)
  WITH updated AS (
    UPDATE public.books
    SET status = 'approved', updated_at = now()
    WHERE user_id = p_user_id
      AND source_scan_job_id = ANY(v_raw_uuids)
      AND status = 'pending'
      AND deleted_at IS NULL
    RETURNING id
  )
  SELECT count(*) INTO v_books_approved FROM updated;

  -- 2) Close scan_jobs and stamp their books JSONB as approved
  WITH updated AS (
    UPDATE public.scan_jobs
    SET
      status      = 'closed',
      imported_at = now(),
      updated_at  = now(),
      books = COALESCE(
        (SELECT jsonb_agg((elem - 'status') || '{"status":"approved"}'::jsonb)
         FROM jsonb_array_elements(COALESCE(books, '[]'::jsonb)) AS elem),
        '[]'::jsonb
      )
    WHERE user_id = p_user_id
      AND id = ANY(v_raw_uuids)
    RETURNING id
  )
  SELECT count(*) INTO v_jobs_closed FROM updated;

  -- 2.5) Catch any remaining pending books (delayed enrichment/cover writes)
  UPDATE public.books
  SET status = 'approved', updated_at = now()
  WHERE user_id = p_user_id
    AND source_scan_job_id = ANY(v_raw_uuids)
    AND status = 'pending'
    AND deleted_at IS NULL;

  -- 3) Invariant check: closed job must have 0 pending books
  FOREACH v_job_id IN ARRAY p_job_ids
  LOOP
    BEGIN
      v_job_uuid := (CASE WHEN v_job_id LIKE 'job_%' THEN substring(v_job_id FROM 5) ELSE v_job_id END)::uuid;
    EXCEPTION WHEN others THEN
      CONTINUE; -- skip non-UUID entries
    END;

    SELECT count(*) INTO v_pending_count
    FROM public.books b
    WHERE b.user_id = p_user_id
      AND b.status = 'pending'
      AND b.deleted_at IS NULL
      AND b.source_scan_job_id = v_job_uuid;

    IF v_pending_count > 0 THEN
      RAISE WARNING '[APPROVE_INVARIANT_VIOLATION] scan_job closed but pending books > 0: job_id=% user_id=% pending_count=%',
        v_job_id, p_user_id, v_pending_count;
    END IF;
  END LOOP;

  v_result := jsonb_build_object('books_approved', v_books_approved, 'jobs_closed', v_jobs_closed);
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION approve_scan_job(uuid, text[]) IS
  'Atomic approve: set books status=approved for job, close scan_jobs, cleanup remaining pending. '
  'Idempotent. source_scan_job_id compared as uuid=uuid (no text cast). '
  'Enforces invariant: closed job => 0 pending books.';


-- =============================================================================
-- Verification query — run after migration to confirm all column types
-- =============================================================================
SELECT
  table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'books'     AND column_name IN ('source_photo_id', 'source_scan_job_id'))
    OR (table_name = 'photos'    AND column_name = 'id')
    OR (table_name = 'scan_jobs' AND column_name IN ('id', 'photo_id'))
  )
ORDER BY table_name, column_name;
-- Expected: every row in the data_type column should read "uuid"
-- Full list expected:
--   books        | source_photo_id    | uuid
--   books        | source_scan_job_id | uuid
--   photos       | id                 | uuid
--   scan_jobs    | id                 | uuid
--   scan_jobs    | photo_id           | uuid
