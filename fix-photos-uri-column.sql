-- ============================================================
-- Fix Photos Table - Add Missing URI Column
-- ============================================================
-- Run this in your DEV Supabase SQL Editor
-- This adds the missing 'uri' column to the photos table
-- ============================================================

-- Add uri column if it doesn't exist
ALTER TABLE public.photos 
  ADD COLUMN IF NOT EXISTS uri TEXT;

-- Update existing photos to use storage_url as uri (for backward compatibility)
UPDATE public.photos 
SET uri = storage_url 
WHERE uri IS NULL AND storage_url IS NOT NULL;

-- Add comment
COMMENT ON COLUMN public.photos.uri IS 'Legacy URI column for backward compatibility with older app versions';





