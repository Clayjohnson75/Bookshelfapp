-- Fix scanned_at column type from TIMESTAMPTZ to BIGINT
-- Run this in your Supabase SQL Editor to fix the type mismatch
-- This fixes the "date/time field value out of range" errors

-- Step 1: Check current column type and convert if needed
DO $$ 
DECLARE
  current_type TEXT;
BEGIN
  -- Get the current data type of scanned_at
  SELECT data_type INTO current_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'books'
    AND column_name = 'scanned_at';

  -- If it's TIMESTAMPTZ or TIMESTAMP, convert to BIGINT
  IF current_type IN ('timestamp with time zone', 'timestamp without time zone') THEN
    RAISE NOTICE 'Converting scanned_at from % to BIGINT...', current_type;
    
    -- Add a temporary column
    ALTER TABLE public.books ADD COLUMN scanned_at_new BIGINT;
    
    -- Convert existing TIMESTAMPTZ values to BIGINT (milliseconds)
    -- If scanned_at is null, keep it null
    -- If scanned_at has a value, convert it to milliseconds since epoch
    UPDATE public.books
    SET scanned_at_new = CASE
      WHEN scanned_at IS NULL THEN NULL
      ELSE EXTRACT(EPOCH FROM scanned_at)::BIGINT * 1000
    END;
    
    -- Drop the old column
    ALTER TABLE public.books DROP COLUMN scanned_at;
    
    -- Rename the new column to scanned_at
    ALTER TABLE public.books RENAME COLUMN scanned_at_new TO scanned_at;
    
    RAISE NOTICE 'scanned_at column converted to BIGINT successfully';
  ELSIF current_type = 'bigint' THEN
    RAISE NOTICE 'scanned_at is already BIGINT, no conversion needed';
  ELSE
    RAISE NOTICE 'scanned_at column type is %, expected TIMESTAMPTZ or BIGINT', current_type;
  END IF;
END $$;

-- Step 2: Ensure scanned_at is BIGINT (in case it doesn't exist or was dropped)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'books' 
    AND column_name = 'scanned_at'
  ) THEN
    ALTER TABLE public.books ADD COLUMN scanned_at BIGINT;
    RAISE NOTICE 'scanned_at column added as BIGINT';
  END IF;
END $$;


