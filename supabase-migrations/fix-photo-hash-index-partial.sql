-- ============================================================
-- Fix: photo hash unique index must only cover active (non-deleted) rows
-- ============================================================
-- The current unique index unique_photo_per_user_hash covers ALL rows including
-- soft-deleted ones (deleted_at IS NOT NULL). This means:
--
--   1. User scans image → photo row inserted, unique index claims the hash.
--   2. User deletes the photo → photo row soft-deleted (deleted_at = now()).
--   3. User rescans the same image → INSERT fails with 23505 unique violation
--      because the deleted row still occupies the hash slot.
--   4. The 23505 recovery path tries to reuse the deleted row → scan attaches
--      to a deleted photo → appears then immediately vanishes.
--
-- Fix: replace the full unique index with a partial unique index that only
-- enforces uniqueness among active (non-deleted) rows. Deleted rows can then
-- be "forgotten" by the hash constraint, allowing the same hash to be reused
-- for a fresh photo row after the original was deleted.
-- ============================================================

-- Step 1: Drop the old full unique index (covers deleted rows too)
DROP INDEX IF EXISTS unique_photo_per_user_hash;

-- Step 2: Create a partial unique index — only active rows compete for hash slots
CREATE UNIQUE INDEX unique_active_photo_per_user_hash
  ON photos (user_id, image_hash)
  WHERE deleted_at IS NULL;

-- Verify: this allows inserting a new row with the same (user_id, image_hash)
-- as long as the previous row has deleted_at set.
-- ============================================================
