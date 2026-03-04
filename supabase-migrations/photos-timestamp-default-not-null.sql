-- photos.timestamp: BIGINT (epoch ms). Set default and NOT NULL so inserts never get null.
-- Backfill any existing NULLs so NOT NULL can be applied.

UPDATE public.photos
SET "timestamp" = (extract(epoch from now()) * 1000)::bigint
WHERE "timestamp" IS NULL;

ALTER TABLE public.photos
  ALTER COLUMN "timestamp" SET DEFAULT (extract(epoch from now()) * 1000)::bigint;

ALTER TABLE public.photos
  ALTER COLUMN "timestamp" SET NOT NULL;

COMMENT ON COLUMN public.photos."timestamp" IS
  'BIGINT epoch milliseconds. Default: server now. Never null.';
