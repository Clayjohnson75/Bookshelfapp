-- Add status and approved_count columns to photos.
-- status: 'draft' (upload in progress), 'complete' (ready to display), 'discarded'
-- approved_count: number of books from this photo that have been approved

ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';

ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS approved_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE photos
  DROP CONSTRAINT IF EXISTS photos_status_check;

ALTER TABLE photos
  ADD CONSTRAINT photos_status_check
  CHECK (status IN ('draft', 'complete', 'discarded'));

CREATE INDEX IF NOT EXISTS photos_user_status_idx
  ON photos(user_id, status);
