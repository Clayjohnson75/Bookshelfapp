-- Migration: Create scan_jobs table for async scan processing
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- 
-- WHY THIS TABLE IS NEEDED:
-- 1. Async job model: Client creates job, server processes in background
-- 2. No more 2-minute timeouts: Jobs can take as long as needed
-- 3. Progress tracking: Client can poll for status and see progress
-- 4. Reliability: Server continues processing even if client disconnects
-- 5. Job persistence: Jobs survive server restarts (can be retried)

CREATE TABLE IF NOT EXISTS scan_jobs (
  -- Primary key: unique job identifier (e.g., "job_1234567890_abc123")
  id TEXT PRIMARY KEY,
  
  -- User who initiated the scan (nullable for guest users)
  user_id TEXT,
  
  -- Image storage path (image stored in Supabase Storage, not in DB)
  image_path TEXT NOT NULL,
  -- Image hash for deduplication
  image_hash TEXT,
  
  -- Job status: pending → processing → completed/failed
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  
  -- Final results: array of book objects (JSONB for querying)
  books JSONB DEFAULT '[]'::jsonb,
  
  -- API results: which APIs worked, error info (for debugging)
  api_results JSONB,
  
  -- Error message if job failed
  error TEXT,
  
  -- Progress tracking: current stage and books found so far
  -- Example: { "stage": "gemini", "booksFound": 8 }
  progress JSONB,
  
  -- Timestamps for tracking job lifecycle
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookups by user (if you want to show user's job history)
CREATE INDEX IF NOT EXISTS idx_scan_jobs_user_id ON scan_jobs(user_id);

-- Index for finding pending/processing jobs (for cleanup or retry)
CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs(status);

-- Index for cleanup: find old completed jobs to delete
CREATE INDEX IF NOT EXISTS idx_scan_jobs_created_at ON scan_jobs(created_at);

-- Optional: Add RLS (Row Level Security) policies if you want user isolation
-- Uncomment if you want users to only see their own jobs:
-- ALTER TABLE scan_jobs ENABLE ROW LEVEL SECURITY;
-- 
-- CREATE POLICY "Users can view their own scan jobs"
--   ON scan_jobs FOR SELECT
--   USING (auth.uid()::text = user_id);
-- 
-- Note: The API uses service role key, so it bypasses RLS anyway.
-- RLS is only needed if you want client-side direct access to scan_jobs.

-- Optional: Add trigger to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_scan_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_scan_jobs_updated_at
  BEFORE UPDATE ON scan_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_scan_jobs_updated_at();

-- Optional: Cleanup function to delete old completed jobs (run periodically)
-- You can call this from a cron job or manually:
-- SELECT cleanup_old_scan_jobs(7); -- Delete jobs older than 7 days
CREATE OR REPLACE FUNCTION cleanup_old_scan_jobs(days_to_keep INTEGER DEFAULT 7)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM scan_jobs
  WHERE status IN ('completed', 'failed')
    AND created_at < NOW() - (days_to_keep || ' days')::INTERVAL;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

