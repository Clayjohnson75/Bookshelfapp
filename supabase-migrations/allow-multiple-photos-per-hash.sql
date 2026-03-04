-- Allow multiple photos per (user_id, image_hash) so every new capture gets its own photo row and id.
-- Previously: unique_photo_per_user_hash forced one row per hash, so re-uploading the same/similar image
-- reused the same row (including previously deleted photos). Now: each new photo insert gets a new id.

drop index if exists unique_photo_per_user_hash;

-- Optional: keep a non-unique index for queries by (user_id, image_hash)
create index if not exists photos_user_id_image_hash_idx
on photos(user_id, image_hash)
where image_hash is not null;
