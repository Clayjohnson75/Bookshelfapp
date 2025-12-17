-- Create scan_jobs table for background scanning
-- This table stores scan jobs that are processed asynchronously on the server
-- Even if the app is closed, scans will continue processing

CREATE TABLE IF NOT EXISTS scan_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  image_data TEXT NOT NULL, -- Base64 encoded image data
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  books JSONB DEFAULT '[]'::jsonb, -- Array of detected books
  error TEXT, -- Error message if status is 'failed'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create index on user_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_scan_jobs_user_id ON scan_jobs(user_id);

-- Create index on status for filtering
CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs(status);

-- Create index on updated_at for syncing
CREATE INDEX IF NOT EXISTS idx_scan_jobs_updated_at ON scan_jobs(updated_at);

-- Create index on user_id + status for efficient queries
CREATE INDEX IF NOT EXISTS idx_scan_jobs_user_status ON scan_jobs(user_id, status);

-- Add comment
COMMENT ON TABLE scan_jobs IS 'Stores background scan jobs that continue processing even when the app is closed';


