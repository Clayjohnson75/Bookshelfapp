-- ============================================================
-- RECOVERY: Undo accidental bulk soft-delete of books + photos
-- ============================================================
-- The PROBE_BOOKS_ANY_STATUS and VERIFY_VS_FETCHALL_AUDIT logs showed that
-- rows with status='approved' had deleted_at populated, causing fetchAllApprovedBooks
-- to return 0 rows (filter: deleted_at IS NULL).
--
-- Symptoms of an accidental bulk delete (all same timestamp):
--   - Multiple rows with identical deleted_at values
--   - Rows with status='approved' having deleted_at set
--   - Many rows with deleted_at set at the same second
--
-- This migration identifies and restores rows that look like accidental bulk deletes.
-- Run this ONCE after diagnosis. Adjust the timestamp window if needed.
-- ============================================================

-- Step 1: Preview — see the distinct deleted_at timestamps that affected many rows at once.
-- Run this SELECT first to identify the "bulk delete" timestamps:
--
-- SELECT deleted_at, COUNT(*) AS affected_rows, COUNT(*) FILTER (WHERE status = 'approved') AS approved_rows
-- FROM books
-- WHERE deleted_at IS NOT NULL
-- GROUP BY deleted_at
-- ORDER BY affected_rows DESC
-- LIMIT 20;
--
-- SELECT deleted_at, COUNT(*) AS affected_rows
-- FROM photos
-- WHERE deleted_at IS NOT NULL
-- GROUP BY deleted_at
-- ORDER BY affected_rows DESC
-- LIMIT 20;

-- Step 2: Restore books — clear deleted_at on approved books that were accidentally soft-deleted.
-- A bulk (same-second) delete of approved books is always accidental: approve writes status='approved'
-- and never sets deleted_at. Only SettingsModal "Clear Account Data" bulk-deletes approved rows.
--
-- IMPORTANT: Review the WHERE clause before running. Adjust the timestamp if you want to be
-- more precise (e.g., WHERE deleted_at = '2026-02-24T15:23:43.746Z' to target exact timestamp).

-- Restore ALL approved books that have deleted_at set — "approved + deleted" is always a contradiction.
-- Intentional book removals go through delete_library_book RPC which sets status='deleted' (not 'approved').

UPDATE books
SET
  deleted_at  = NULL,
  updated_at  = NOW()
WHERE
  deleted_at IS NOT NULL
  AND status = 'approved'
;

-- Step 3: Restore photos — clear deleted_at on ALL photos that were soft-deleted.
-- SettingsModal bulk-clears all photos in one shot; restoring all of them is safe.

UPDATE photos
SET
  deleted_at  = NULL,
  updated_at  = NOW()
WHERE
  deleted_at IS NOT NULL
;

-- Step 4: Verify recovery
SELECT
  status,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE deleted_at IS NULL)  AS not_deleted,
  COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS still_deleted
FROM books
GROUP BY status
ORDER BY status;
