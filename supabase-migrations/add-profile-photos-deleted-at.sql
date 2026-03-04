-- Add soft-delete support to profile_photos.
-- The app's "Clear Account Data" flow in SettingsModal calls
--   .update({ deleted_at: now }) on profile_photos
-- but the column did not exist, causing PGRST204 and aborting the clear-data flow.
--
-- After running this migration, restart the Supabase API / refresh the PostgREST schema
-- cache in the Supabase dashboard so the new column is picked up immediately.

alter table public.profile_photos
  add column if not exists deleted_at timestamptz;

-- Index speeds up the IS NULL filter used in load queries.
create index if not exists profile_photos_deleted_at_idx
  on public.profile_photos (user_id, deleted_at);

-- Comment documents intent.
comment on column public.profile_photos.deleted_at is
  'Soft-delete timestamp. NULL = active. Set by Clear Account Data; cleared on next avatar upload.';
