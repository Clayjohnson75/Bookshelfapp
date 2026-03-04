-- Add image_hash column to photos table.
-- Used for server-side deduplication: if a row already exists for (user_id, image_hash),
-- the scan pipeline reuses that photo id instead of inserting a new row.
-- See add-unique-photo-per-user-hash.sql to enforce uniqueness (or allow-multiple-photos-per-hash.sql to relax it).

ALTER TABLE photos
  ADD COLUMN image_hash TEXT;

CREATE INDEX photos_image_hash_idx
  ON photos(user_id, image_hash);
