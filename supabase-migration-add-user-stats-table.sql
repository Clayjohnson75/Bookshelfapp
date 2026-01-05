-- ============================================================
-- BOOKSHELF SCANNER - User Stats Table Migration
-- ============================================================
-- Copy and paste this entire file into your Supabase SQL Editor
-- This creates the user_stats table for tracking user count and scan count per user
-- ============================================================

-- Create user_stats table to track user statistics
CREATE TABLE IF NOT EXISTS public.user_stats (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  total_scans INTEGER DEFAULT 0 NOT NULL,
  last_scan_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_user_stats_user_id ON public.user_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_user_stats_total_scans ON public.user_stats(total_scans);
CREATE INDEX IF NOT EXISTS idx_user_stats_last_scan_at ON public.user_stats(last_scan_at);

-- Enable Row Level Security (RLS)
ALTER TABLE public.user_stats ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own stats
CREATE POLICY "Users can view own stats" ON public.user_stats
  FOR SELECT USING (auth.uid() = user_id);

-- Policy: Users can update their own stats (for incrementing scan count)
CREATE POLICY "Users can update own stats" ON public.user_stats
  FOR UPDATE USING (auth.uid() = user_id);

-- Policy: System can insert stats for users (via service role or trigger)
-- Note: This allows the API to create stats records when needed
CREATE POLICY "System can insert user stats" ON public.user_stats
  FOR INSERT WITH CHECK (true);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_user_stats_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update updated_at on stats updates
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'trigger_update_user_stats_updated_at'
  ) THEN
    CREATE TRIGGER trigger_update_user_stats_updated_at
      BEFORE UPDATE ON public.user_stats
      FOR EACH ROW
      EXECUTE FUNCTION public.update_user_stats_updated_at();
  END IF;
END $$;

-- Function to increment scan count for a user
-- This can be called from the API to track scans
CREATE OR REPLACE FUNCTION public.increment_user_scan_count(user_uuid UUID)
RETURNS void AS $$
BEGIN
  INSERT INTO public.user_stats (user_id, total_scans, last_scan_at, created_at, updated_at)
  VALUES (user_uuid, 1, NOW(), NOW(), NOW())
  ON CONFLICT (user_id) 
  DO UPDATE SET 
    total_scans = user_stats.total_scans + 1,
    last_scan_at = NOW(),
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission on the function to authenticated users
GRANT EXECUTE ON FUNCTION public.increment_user_scan_count(UUID) TO authenticated;

-- ============================================================
-- Migration complete!
-- Your user_stats table is now ready for tracking scans
-- ============================================================
-- 
-- Usage:
-- To increment scan count for a user, call:
--   SELECT increment_user_scan_count('user-uuid-here');
--
-- To get user stats:
--   SELECT * FROM user_stats WHERE user_id = 'user-uuid-here';
--
-- To get total user count:
--   SELECT COUNT(*) FROM user_stats;
--
-- To get total scans across all users:
--   SELECT SUM(total_scans) FROM user_stats;
-- ============================================================









