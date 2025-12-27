-- ============================================================
-- BOOKSHELF SCANNER - Photos Table Migration
-- ============================================================
-- Copy and paste this entire file into your Supabase SQL Editor
-- This creates the photos table for storing user photos permanently
-- ============================================================

-- Create photos table to store user's photos with books
CREATE TABLE IF NOT EXISTS public.photos (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  storage_path TEXT NOT NULL, -- Path in Supabase Storage
  storage_url TEXT NOT NULL, -- Public URL to the photo
  books JSONB DEFAULT '[]'::jsonb NOT NULL, -- Array of books detected in this photo
  timestamp BIGINT NOT NULL, -- Unix timestamp when photo was taken
  caption TEXT, -- Optional caption/label for the photo location
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_photos_user_id ON public.photos(user_id);
CREATE INDEX IF NOT EXISTS idx_photos_user_id_timestamp ON public.photos(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_photos_user_id_created_at ON public.photos(user_id, created_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (allows re-running migration)
DROP POLICY IF EXISTS "Users can view own photos" ON public.photos;
DROP POLICY IF EXISTS "Users can insert own photos" ON public.photos;
DROP POLICY IF EXISTS "Users can update own photos" ON public.photos;
DROP POLICY IF EXISTS "Users can delete own photos" ON public.photos;

-- Policy: Users can view their own photos
CREATE POLICY "Users can view own photos" ON public.photos
  FOR SELECT USING (auth.uid() = user_id);

-- Policy: Users can insert their own photos
CREATE POLICY "Users can insert own photos" ON public.photos
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Policy: Users can update their own photos
CREATE POLICY "Users can update own photos" ON public.photos
  FOR UPDATE USING (auth.uid() = user_id);

-- Policy: Users can delete their own photos
CREATE POLICY "Users can delete own photos" ON public.photos
  FOR DELETE USING (auth.uid() = user_id);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_photos_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update updated_at on photo updates
DROP TRIGGER IF EXISTS update_photos_updated_at_trigger ON public.photos;
CREATE TRIGGER update_photos_updated_at_trigger
  BEFORE UPDATE ON public.photos
  FOR EACH ROW
  EXECUTE FUNCTION public.update_photos_updated_at();

-- Add comment
COMMENT ON TABLE public.photos IS 'Stores user photos with detected books, synced across devices';

