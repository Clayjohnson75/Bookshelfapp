-- Optional: partial unique index on (user_id, book_key) so only non-deleted rows
-- are unique. Prevents deleted rows (from Clear Library) from "capturing" future
-- scan upserts; new scans insert new rows instead of matching old deleted rows.
--
-- Alternative: keep the full unique (user_id, book_key) and rely on scan upsert
-- always setting deleted_at = null (api/scan.ts) so upsert revives deleted rows.
-- If you apply this migration, PostgREST upsert with onConflict 'user_id,book_key'
-- may fail (no full unique constraint); then use insert + update by source_scan_job_id
-- or keep the full constraint and rely on revive.
--
-- If you already have UNIQUE (user_id, book_key), drop it and replace with this.
-- Constraint names vary; adjust or run manually if your schema differs.

-- Drop existing unique constraint/index on (user_id, book_key) if present.
ALTER TABLE public.books
  DROP CONSTRAINT IF EXISTS books_user_id_book_key_key;

-- Some setups use a unique index instead of a constraint.
DROP INDEX IF EXISTS public.books_user_id_book_key_key;

-- Partial unique index: uniqueness only for non-deleted rows.
CREATE UNIQUE INDEX IF NOT EXISTS books_user_id_book_key_non_deleted_key
  ON public.books (user_id, book_key)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX public.books_user_id_book_key_non_deleted_key IS
  'One active (non-deleted) book per (user_id, book_key). Deleted rows do not capture future scan upserts.';
