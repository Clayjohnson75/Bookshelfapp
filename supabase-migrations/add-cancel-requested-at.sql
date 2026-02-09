-- Migration: Add cancel_requested_at column to scan_jobs
-- Goal: Track when cancellation was requested for better observability
-- Date: 2026-02-04

-- Add cancel_requested_at column (timestamp when cancel was requested)
ALTER TABLE public.scan_jobs
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ NULL;

-- Add index for efficient queries
CREATE INDEX IF NOT EXISTS idx_scan_jobs_cancel_requested_at 
  ON public.scan_jobs (cancel_requested_at) 
  WHERE cancel_requested_at IS NOT NULL;

-- Add comment
COMMENT ON COLUMN public.scan_jobs.cancel_requested_at IS 
  'Timestamp when cancellation was requested. Used for observability and ensuring cancellation is respected.';


