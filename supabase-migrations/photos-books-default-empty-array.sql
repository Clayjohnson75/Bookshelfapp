-- Fix: photos.books column lacks a DEFAULT, causing NOT NULL violations when the
-- server-side photo insert omits the field.
--
-- Root cause: api/scan.ts inserts a photo row without a books field. If the column
-- has NOT NULL and no DEFAULT the insert fails with:
--   "null value in column "books" of relation "photos" violates not-null constraint"
-- That failure cascades: scan_jobs.photo_id FK patch then also fails because the
-- photos row was never created, making the entire server snapshot for that photo
-- return 0 rows.
--
-- Fix A (applied here): set DEFAULT '[]'::jsonb so any insert that omits books
-- gets an empty array automatically.
-- Fix B (also applied): allow NULL as a belt-and-suspenders guard — a NULL books
-- field is less broken than a missing row, and clients already COALESCE(books, '[]').

ALTER TABLE photos
  ALTER COLUMN books SET DEFAULT '[]'::jsonb;

-- Belt-and-suspenders: also backfill any existing NULL rows so they are consistent.
UPDATE photos
  SET books = '[]'::jsonb
  WHERE books IS NULL;
