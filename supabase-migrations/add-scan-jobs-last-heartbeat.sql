-- Add last_heartbeat_at to scan_jobs so we can detect stuck jobs (processing but no progress).
-- Worker updates this on each progress write; reaper marks jobs as failed when updated_at and last_heartbeat_at are stale.

ALTER TABLE scan_jobs
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;

COMMENT ON COLUMN scan_jobs.last_heartbeat_at IS
  'Set by worker on each progress update; used with updated_at to detect stuck processing jobs.';
