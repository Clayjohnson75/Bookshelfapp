-- ============================================================
-- BOOKSHELF SCANNER - Fix Photos Table Columns
-- ============================================================
-- This script adds the missing columns to the photos table
-- Use this if the migration didn't work or schema cache is stale
-- ============================================================

-- First, check if the table exists and what columns it has
-- (This is just for reference - you can run this separately to verify)
-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'photos' AND table_schema = 'public';

-- Add storage_path column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'photos' 
    AND column_name = 'storage_path'
  ) THEN
    ALTER TABLE public.photos ADD COLUMN storage_path TEXT;
    RAISE NOTICE 'Added storage_path column';
  ELSE
    RAISE NOTICE 'storage_path column already exists';
  END IF;
END $$;

-- Add storage_url column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'photos' 
    AND column_name = 'storage_url'
  ) THEN
    ALTER TABLE public.photos ADD COLUMN storage_url TEXT;
    RAISE NOTICE 'Added storage_url column';
  ELSE
    RAISE NOTICE 'storage_url column already exists';
  END IF;
END $$;

-- Make storage_path NOT NULL if it's currently nullable (but allow NULL for now to avoid breaking existing data)
-- We'll update existing rows first, then make it NOT NULL
-- For now, just ensure the column exists

-- Verify the columns were added
SELECT 
  column_name, 
  data_type, 
  is_nullable
FROM information_schema.columns 
WHERE table_schema = 'public' 
  AND table_name = 'photos'
  AND column_name IN ('storage_path', 'storage_url')
ORDER BY column_name;




