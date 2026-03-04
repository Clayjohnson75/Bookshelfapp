-- Add processing_stage to photos for pipeline state (queued/uploading/scanning/saving/failed).
-- DB status column is strictly: 'draft' | 'complete' | 'discarded' (photos_status_check).
-- Pipeline states live here so we never send illegal status values.

ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS processing_stage TEXT;

COMMENT ON COLUMN photos.processing_stage IS
  'Pipeline state: queued, uploading, uploaded, processing, complete, failed. Null = not in pipeline. status column remains draft|complete|discarded only.';
