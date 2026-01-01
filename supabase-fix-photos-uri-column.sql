-- ============================================================
-- BOOKSHELF SCANNER - Fix Photos Table URI Column
-- ============================================================
-- This script fixes the uri column constraint issue
-- ============================================================

-- Check if uri column exists and make it nullable (or remove if not needed)
DO $$ 
BEGIN
  -- If uri column exists, make it nullable since we're using storage_url now
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'photos' 
    AND column_name = 'uri'
  ) THEN
    -- Make uri nullable (we use storage_url as primary now)
    ALTER TABLE public.photos ALTER COLUMN uri DROP NOT NULL;
    RAISE NOTICE 'Made uri column nullable';
  ELSE
    RAISE NOTICE 'uri column does not exist';
  END IF;
END $$;

-- Verify the change
SELECT 
  column_name, 
  data_type, 
  is_nullable
FROM information_schema.columns 
WHERE table_schema = 'public' 
  AND table_name = 'photos'
  AND column_name IN ('uri', 'storage_path', 'storage_url')
ORDER BY column_name;




