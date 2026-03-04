-- Formalize Photo lifecycle: allow DB row before upload completes.
--
-- 1) storage_path must be nullable — photos can exist in DB while upload is in progress.
--    Do NOT filter photos out just because storage_path is null; those are "uploading" photos.
-- 2) Expand status check to accept full lifecycle: local_pending, uploading, uploaded,
--    processing, complete, failed_upload, failed_processing, plus legacy draft, stalled,
--    discarded, errored.

-- Ensure storage_path is nullable (no-op if already nullable).
ALTER TABLE photos
  ALTER COLUMN storage_path DROP NOT NULL;

-- Expand status constraint so client can write lifecycle values.
ALTER TABLE photos
  DROP CONSTRAINT IF EXISTS photos_status_check;

ALTER TABLE photos
  ADD CONSTRAINT photos_status_check
  CHECK (status IN (
    'local_pending', 'uploading', 'uploaded', 'processing', 'complete',
    'failed_upload', 'failed_processing',
    'draft', 'stalled', 'discarded', 'errored'
  ));

COMMENT ON COLUMN photos.storage_path IS
  'Nullable until upload completes. Do not filter photos by storage_path alone — uploading photos have null storage_path.';
