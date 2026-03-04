-- When create_scan_job fails (e.g. 413), set photo status to scan_failed so it does not appear as a normal photo.
-- Add scan_failed to allowed statuses and optional scan_error for metadata.

ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS scan_error JSONB;

ALTER TABLE photos
  DROP CONSTRAINT IF EXISTS photos_status_check;

-- Include common values so this works whether add-photos-status or photos-lifecycle was applied.
ALTER TABLE photos
  ADD CONSTRAINT photos_status_check
  CHECK (status IN (
    'draft', 'complete', 'discarded', 'scan_failed',
    'local_pending', 'uploading', 'uploaded', 'processing',
    'failed_upload', 'failed_processing', 'stalled', 'errored'
  ));

COMMENT ON COLUMN photos.scan_error IS 'Error metadata when status = scan_failed (e.g. code: 413, message).';