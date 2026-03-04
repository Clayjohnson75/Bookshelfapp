-- =============================================================================
-- Make books.source_photo_id FK deferrable (initially deferred)
-- =============================================================================
--
-- WHY:
--   The FK  books.source_photo_id → photos.id  is currently IMMEDIATE.
--   Any INSERT/UPDATE on books that sets source_photo_id is validated
--   row-by-row at statement time.  If the photo row doesn't exist yet
--   (ordering race, retry, import-before-upload) the statement fails with:
--
--     insert or update on table "books" violates foreign key constraint
--     "books_source_photo_id_fkey"
--
--   DEFERRABLE INITIALLY DEFERRED moves the check to commit time.
--   Within a single transaction the photo can arrive after the book row
--   is written — as long as everything is consistent at COMMIT.
--   Client upserts outside an explicit transaction are auto-committed
--   immediately, so they still see the check — but the two-step write
--   pattern below (write book without source_photo_id, then PATCH it in)
--   avoids the race entirely regardless of deferral.
--
-- WHAT CHANGES:
--   1. Drop the existing IMMEDIATE FK (added by standardize-photo-id-columns-uuid.sql).
--   2. Re-add it as DEFERRABLE INITIALLY DEFERRED.
--   3. No data changes — column stays uuid nullable.
--   4. ON DELETE SET NULL is preserved (soft-delete cascade path unchanged).
--
-- SAFE TO RE-RUN: DROP CONSTRAINT IF EXISTS guards the idempotency.
-- =============================================================================

ALTER TABLE books
  DROP CONSTRAINT IF EXISTS books_source_photo_id_fkey;

ALTER TABLE books
  ADD CONSTRAINT books_source_photo_id_fkey
  FOREIGN KEY (source_photo_id)
  REFERENCES photos(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

-- Verify
SELECT
  tc.constraint_name,
  tc.constraint_type,
  tc.is_deferrable,
  tc.initially_deferred
FROM information_schema.table_constraints tc
WHERE tc.table_schema = 'public'
  AND tc.table_name   = 'books'
  AND tc.constraint_name = 'books_source_photo_id_fkey';
-- Expected:
--   constraint_name              | constraint_type | is_deferrable | initially_deferred
--   books_source_photo_id_fkey   | FOREIGN KEY     | YES           | YES
