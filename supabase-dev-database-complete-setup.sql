-- ============================================================
-- COMPLETE DEVELOPMENT DATABASE SETUP
-- ============================================================
-- Run this ENTIRE file in your DEVELOPMENT Supabase SQL Editor
-- This sets up everything from scratch for a new dev database
-- ============================================================

-- ============================================================
-- STEP 1: Create Profiles Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS (Row Level Security)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can delete own profile" ON public.profiles;

-- Allow users to read their own profile
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

-- Allow users to update their own profile
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- Allow users to insert their own profile
CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Allow users to delete their own profile
CREATE POLICY "Users can delete own profile" ON public.profiles
  FOR DELETE USING (auth.uid() = id);

-- Function to automatically create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, username, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', 'user_' || substr(NEW.id::text, 1, 8)),
    NEW.raw_user_meta_data->>'display_name'
  )
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    display_name = EXCLUDED.display_name;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

-- Trigger to create profile on user signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- STEP 2: Create Books Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.books (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  isbn TEXT,
  cover_url TEXT,
  local_cover_path TEXT,
  google_books_id TEXT,
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'incomplete')),
  scanned_at TIMESTAMPTZ DEFAULT NOW(),
  confidence TEXT DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- Google Books API stats
  page_count INTEGER,
  categories TEXT[],
  publisher TEXT,
  published_date TEXT,
  language TEXT,
  average_rating NUMERIC(3, 2),
  ratings_count INTEGER,
  subtitle TEXT,
  print_type TEXT,
  -- Unique constraint: one book per user per title/author combination
  CONSTRAINT idx_books_user_title_author_unique UNIQUE (user_id, title, author)
);

-- Enable RLS
ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view own books" ON public.books;
DROP POLICY IF EXISTS "Users can insert own books" ON public.books;
DROP POLICY IF EXISTS "Users can update own books" ON public.books;
DROP POLICY IF EXISTS "Users can delete own books" ON public.books;

-- RLS Policies for books
CREATE POLICY "Users can view own books" ON public.books
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own books" ON public.books
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own books" ON public.books
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own books" ON public.books
  FOR DELETE USING (auth.uid() = user_id);

-- Indexes for books
CREATE INDEX IF NOT EXISTS idx_books_user_id ON public.books(user_id);
CREATE INDEX IF NOT EXISTS idx_books_status ON public.books(status);
CREATE INDEX IF NOT EXISTS idx_books_scanned_at ON public.books(scanned_at);

-- ============================================================
-- STEP 3: Create Photos Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.photos (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  storage_path TEXT,
  storage_url TEXT,
  uri TEXT,
  books JSONB DEFAULT '[]'::jsonb,
  timestamp BIGINT NOT NULL,
  caption TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view own photos" ON public.photos;
DROP POLICY IF EXISTS "Users can insert own photos" ON public.photos;
DROP POLICY IF EXISTS "Users can update own photos" ON public.photos;
DROP POLICY IF EXISTS "Users can delete own photos" ON public.photos;

-- RLS Policies for photos
CREATE POLICY "Users can view own photos" ON public.photos
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own photos" ON public.photos
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own photos" ON public.photos
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own photos" ON public.photos
  FOR DELETE USING (auth.uid() = user_id);

-- Indexes for photos
CREATE INDEX IF NOT EXISTS idx_photos_user_id ON public.photos(user_id);
CREATE INDEX IF NOT EXISTS idx_photos_timestamp ON public.photos(timestamp);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION public.update_photos_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_photos_updated_at ON public.photos;
CREATE TRIGGER update_photos_updated_at
  BEFORE UPDATE ON public.photos
  FOR EACH ROW
  EXECUTE FUNCTION public.update_photos_updated_at();

-- ============================================================
-- STEP 4: Create User Stats Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_stats (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  total_scans INTEGER DEFAULT 0 NOT NULL,
  last_scan_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Add monthly tracking columns (if table already existed, this ensures they're added)
ALTER TABLE public.user_stats
  ADD COLUMN IF NOT EXISTS monthly_scans INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS last_scan_month DATE,
  ADD COLUMN IF NOT EXISTS monthly_reset_at TIMESTAMPTZ DEFAULT (DATE_TRUNC('month', NOW()) + INTERVAL '1 month');

-- Enable RLS
ALTER TABLE public.user_stats ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view own stats" ON public.user_stats;
DROP POLICY IF EXISTS "Users can update own stats" ON public.user_stats;
DROP POLICY IF EXISTS "System can insert user stats" ON public.user_stats;

-- RLS Policies
CREATE POLICY "Users can view own stats" ON public.user_stats
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own stats" ON public.user_stats
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "System can insert user stats" ON public.user_stats
  FOR INSERT WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_stats_user_id ON public.user_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_user_stats_monthly_reset_at ON public.user_stats(monthly_reset_at);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION public.update_user_stats_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_stats_updated_at ON public.user_stats;
CREATE TRIGGER update_user_stats_updated_at
  BEFORE UPDATE ON public.user_stats
  FOR EACH ROW
  EXECUTE FUNCTION public.update_user_stats_updated_at();

-- ============================================================
-- STEP 5: Add Subscription Fields to Profiles
-- ============================================================
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro', 'owner')),
  ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'active' CHECK (subscription_status IN ('active', 'cancelled', 'past_due', 'trialing')),
  ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS apple_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS apple_original_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS apple_product_id TEXT;

-- Indexes for subscriptions
CREATE INDEX IF NOT EXISTS idx_profiles_subscription_tier ON public.profiles(subscription_tier);
CREATE INDEX IF NOT EXISTS idx_profiles_apple_transaction_id ON public.profiles(apple_transaction_id);

-- ============================================================
-- STEP 6: Create Subscription Functions
-- ============================================================

-- Function to reset monthly scan count (runs automatically)
CREATE OR REPLACE FUNCTION public.reset_monthly_scans()
RETURNS void AS $$
BEGIN
  UPDATE public.user_stats
  SET 
    monthly_scans = 0,
    monthly_reset_at = DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
  WHERE monthly_reset_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to check if user can scan
CREATE OR REPLACE FUNCTION public.can_user_scan(user_uuid UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_user_tier TEXT;
  v_monthly_count INTEGER;
  v_reset_at TIMESTAMPTZ;
  v_free_limit INTEGER := 5;
BEGIN
  -- Reset monthly scans if needed
  PERFORM public.reset_monthly_scans();
  
  -- Get user's subscription tier
  SELECT COALESCE(subscription_tier, 'free') INTO v_user_tier
  FROM public.profiles
  WHERE id = user_uuid;
  
  -- Pro and owner users have unlimited scans
  IF v_user_tier IN ('pro', 'owner') THEN
    RETURN TRUE;
  END IF;
  
  -- Get monthly scan count
  SELECT COALESCE(monthly_scans, 0), monthly_reset_at
  INTO v_monthly_count, v_reset_at
  FROM public.user_stats
  WHERE user_id = user_uuid;
  
  -- If no stats record exists, user can scan (will be created on first scan)
  IF v_monthly_count IS NULL THEN
    RETURN TRUE;
  END IF;
  
  -- Check if monthly limit reached
  RETURN v_monthly_count < v_free_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get user scan usage
CREATE OR REPLACE FUNCTION public.get_user_scan_usage(user_uuid UUID)
RETURNS TABLE (
  subscription_tier TEXT,
  monthly_scans INTEGER,
  monthly_limit INTEGER,
  scans_remaining INTEGER,
  reset_at TIMESTAMPTZ
) AS $$
DECLARE
  v_user_tier TEXT;
  v_monthly_count INTEGER;
  v_reset_at TIMESTAMPTZ;
  v_free_limit INTEGER := 5;
BEGIN
  -- Reset monthly scans if needed
  PERFORM public.reset_monthly_scans();
  
  -- Get user's subscription tier from profiles table (explicit table alias)
  SELECT COALESCE(p.subscription_tier, 'free') INTO v_user_tier
  FROM public.profiles p
  WHERE p.id = user_uuid;
  
  -- Get monthly scan count from user_stats table (explicit table alias)
  SELECT COALESCE(us.monthly_scans, 0), us.monthly_reset_at
  INTO v_monthly_count, v_reset_at
  FROM public.user_stats us
  WHERE us.user_id = user_uuid;
  
  -- Return usage info using declared variables (not selecting from tables)
  -- Owner and Pro users have unlimited scans (NULL limit)
  IF v_monthly_count IS NOT NULL THEN
    RETURN QUERY SELECT
      COALESCE(v_user_tier, 'free')::TEXT,
      v_monthly_count,
      CASE 
        WHEN COALESCE(v_user_tier, 'free') IN ('pro', 'owner') THEN NULL 
        ELSE v_free_limit 
      END,
      CASE 
        WHEN COALESCE(v_user_tier, 'free') IN ('pro', 'owner') THEN NULL 
        ELSE GREATEST(0, v_free_limit - v_monthly_count)
      END,
      COALESCE(v_reset_at, DATE_TRUNC('month', NOW()) + INTERVAL '1 month');
  ELSE
    -- If no stats record exists, return defaults
    RETURN QUERY SELECT
      COALESCE(v_user_tier, 'free')::TEXT,
      0,
      CASE 
        WHEN COALESCE(v_user_tier, 'free') IN ('pro', 'owner') THEN NULL 
        ELSE v_free_limit 
      END,
      CASE 
        WHEN COALESCE(v_user_tier, 'free') IN ('pro', 'owner') THEN NULL 
        ELSE v_free_limit 
      END,
      DATE_TRUNC('month', NOW()) + INTERVAL '1 month';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to increment user scan count
CREATE OR REPLACE FUNCTION public.increment_user_scan_count(user_uuid UUID)
RETURNS void AS $$
DECLARE
  v_current_month DATE;
  v_reset_at TIMESTAMPTZ;
BEGIN
  -- Reset monthly scans if needed
  PERFORM public.reset_monthly_scans();
  
  v_current_month := DATE_TRUNC('month', NOW())::DATE;
  v_reset_at := DATE_TRUNC('month', NOW()) + INTERVAL '1 month';
  
  -- Insert or update user stats
  INSERT INTO public.user_stats (user_id, total_scans, monthly_scans, last_scan_month, last_scan_at, monthly_reset_at)
  VALUES (user_uuid, 1, 1, v_current_month, NOW(), v_reset_at)
  ON CONFLICT (user_id) DO UPDATE SET
    total_scans = public.user_stats.total_scans + 1,
    monthly_scans = CASE 
      WHEN public.user_stats.last_scan_month = v_current_month 
      THEN public.user_stats.monthly_scans + 1
      ELSE 1
    END,
    last_scan_month = v_current_month,
    last_scan_at = NOW(),
    monthly_reset_at = v_reset_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- STEP 8: Storage Bucket Setup (Manual - Run in Supabase Dashboard)
-- ============================================================
-- NOTE: Storage buckets must be created manually in Supabase Dashboard
-- Go to Storage → Create bucket → Name: "photos" → Public: Yes
--
-- After creating the bucket, run these SQL commands to set up RLS policies:
--
-- Allow authenticated users to upload photos
-- INSERT INTO storage.buckets (id, name, public) 
-- VALUES ('photos', 'photos', true)
-- ON CONFLICT (id) DO NOTHING;
--
-- Allow users to upload their own photos
-- CREATE POLICY "Users can upload own photos" ON storage.objects
--   FOR INSERT WITH CHECK (
--     bucket_id = 'photos' AND 
--     auth.uid()::text = (storage.foldername(name))[1]
--   );
--
-- Allow users to view their own photos
-- CREATE POLICY "Users can view own photos" ON storage.objects
--   FOR SELECT USING (
--     bucket_id = 'photos' AND 
--     auth.uid()::text = (storage.foldername(name))[1]
--   );
--
-- Allow users to delete their own photos
-- CREATE POLICY "Users can delete own photos" ON storage.objects
--   FOR DELETE USING (
--     bucket_id = 'photos' AND 
--     auth.uid()::text = (storage.foldername(name))[1]
--   );
--
-- Allow public read access (since bucket is public)
-- CREATE POLICY "Public can view photos" ON storage.objects
--   FOR SELECT USING (bucket_id = 'photos');
--
-- ============================================================
-- COMPLETE! Your development database is now set up.
-- ============================================================
-- Next steps:
-- 1. Create 'photos' bucket in Storage Dashboard (make it public)
-- 2. Run the storage policies SQL above (or set them up in Dashboard)
-- 3. Test by signing in and scanning a book
-- ============================================================

