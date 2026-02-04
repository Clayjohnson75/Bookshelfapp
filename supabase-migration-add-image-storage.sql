-- Migration: Add image storage columns to scan_jobs table
-- Run this in your Supabase SQL Editor AFTER the initial scan_jobs table is created
-- 
-- WHY THIS MIGRATION:
-- QStash has payload size limits (~1MB), and base64 images are too large.
-- We now store images in Supabase Storage and only store the path in the database.

-- Add image_path column (replaces image_data for new jobs)
ALTER TABLE scan_jobs 
ADD COLUMN IF NOT EXISTS image_path TEXT;

-- Add image_hash column for deduplication
ALTER TABLE scan_jobs
ADD COLUMN IF NOT EXISTS image_hash TEXT;

-- Add scan_id column for correlation logging
ALTER TABLE scan_jobs
ADD COLUMN IF NOT EXISTS scan_id TEXT;

-- Create index on image_hash for faster duplicate detection
CREATE INDEX IF NOT EXISTS idx_scan_jobs_image_hash ON scan_jobs(image_hash);

-- Note: image_data column can remain for backward compatibility with old jobs
-- New jobs will use image_path, old jobs may still have image_data
-- You can optionally drop image_data later after migrating old jobs:
-- ALTER TABLE scan_jobs DROP COLUMN IF EXISTS image_data;

