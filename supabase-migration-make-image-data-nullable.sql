-- Migration: Make image_data nullable (we now use image_path)
-- Run this in your Supabase SQL Editor
-- 
-- WHY THIS MIGRATION:
-- We moved to storing images in Supabase Storage and only storing image_path.
-- The image_data column is kept for backward compatibility but should be nullable.

-- Make image_data nullable (drop NOT NULL constraint)
ALTER TABLE scan_jobs 
ALTER COLUMN image_data DROP NOT NULL;

-- Note: New jobs will use image_path, old jobs may still have image_data
-- You can optionally drop image_data later after migrating old jobs:
-- ALTER TABLE scan_jobs DROP COLUMN IF EXISTS image_data;

