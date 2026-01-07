-- ============================================================
-- BOOKSHELF SCANNER - Public Profiles Migration
-- ============================================================
-- Copy and paste this entire file into your Supabase SQL Editor
-- This enables users to have public shareable profile pages
-- ============================================================

-- Add public profile fields to profiles table
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS public_profile_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS profile_bio TEXT,
  ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ DEFAULT NOW();

-- Enable public profiles for all existing users (for testing)
UPDATE public.profiles 
SET public_profile_enabled = true 
WHERE public_profile_enabled IS NULL OR public_profile_enabled = false;

-- Create index for faster public profile queries
CREATE INDEX IF NOT EXISTS idx_profiles_public_enabled ON public.profiles(public_profile_enabled) WHERE public_profile_enabled = true;
CREATE INDEX IF NOT EXISTS idx_profiles_username ON public.profiles(username);

-- ============================================================
-- RLS Policies for Public Profiles
-- ============================================================

-- Allow anyone to read profiles that have public_profile_enabled = true
-- This policy allows anonymous (unauthenticated) users to view public profiles
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.profiles;
CREATE POLICY "Public profiles are viewable by everyone" ON public.profiles
  FOR SELECT 
  TO public
  USING (public_profile_enabled = true);
  
-- Grant SELECT permission to anon role explicitly
GRANT SELECT ON public.profiles TO anon;

-- Note: The existing "Users can update own profile" policy already allows users
-- to update their own profiles, including public_profile_enabled and profile_bio.
-- No additional policy needed.

-- ============================================================
-- RLS Policies for Public Books
-- ============================================================

-- Allow anyone to read books from users with public profiles
-- Only show approved books (not pending/rejected/incomplete)
DROP POLICY IF EXISTS "Public books are viewable by everyone" ON public.books;
CREATE POLICY "Public books are viewable by everyone" ON public.books
  FOR SELECT 
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = books.user_id
      AND profiles.public_profile_enabled = true
    )
    AND books.status = 'approved'
  );
  
-- Grant SELECT permission to anon role explicitly
GRANT SELECT ON public.books TO anon;

-- ============================================================
-- Function to update profile_updated_at timestamp
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_profile_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.profile_updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_profile_updated_at ON public.profiles;
CREATE TRIGGER update_profile_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (OLD.public_profile_enabled IS DISTINCT FROM NEW.public_profile_enabled 
        OR OLD.profile_bio IS DISTINCT FROM NEW.profile_bio)
  EXECUTE FUNCTION public.update_profile_updated_at();

