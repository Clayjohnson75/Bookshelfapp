-- One scan_job per photo_id (when not deleted). Idempotent Step C: API and trigger get-or-create by photo_id.
-- Prevents duplicate scan jobs for the same photo (e.g. retries, concurrent requests).

-- Step 1: Dedupe — for each photo_id with multiple rows (deleted_at IS NULL), keep one and soft-delete the rest.
-- Keep the row with smallest id per photo_id; set deleted_at = now() on the others.
UPDATE scan_jobs j
SET deleted_at = now()
FROM (
  SELECT id,
    row_number() OVER (PARTITION BY photo_id ORDER BY id ASC) AS rn
  FROM scan_jobs
  WHERE deleted_at IS NULL
    AND photo_id IS NOT NULL
) sub
WHERE j.id = sub.id
  AND sub.rn > 1;

-- Step 2: Partial unique index — only one non-deleted scan_job per photo_id.
CREATE UNIQUE INDEX IF NOT EXISTS scan_jobs_photo_id_unique
  ON scan_jobs(photo_id)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX scan_jobs_photo_id_unique IS
  'Idempotent Step C: at most one active scan_job per photo_id. API and client use get-or-create by photo_id.';
