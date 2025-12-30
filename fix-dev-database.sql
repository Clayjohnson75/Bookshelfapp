-- ============================================================
-- Quick Fix for Dev Database - Add Missing Columns
-- ============================================================
-- Run this in your DEV Supabase SQL Editor to fix missing columns
-- ============================================================

-- Add missing google_books_id column to books table
ALTER TABLE public.books 
  ADD COLUMN IF NOT EXISTS google_books_id TEXT;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_books_google_books_id ON public.books(google_books_id) WHERE google_books_id IS NOT NULL;

-- Add missing uri column to photos table (for backward compatibility)
ALTER TABLE public.photos 
  ADD COLUMN IF NOT EXISTS uri TEXT;

-- Update existing photos to use storage_url as uri
UPDATE public.photos 
SET uri = storage_url 
WHERE uri IS NULL AND storage_url IS NOT NULL;

-- ============================================================
-- Storage Bucket Policies (Run after creating 'photos' bucket)
-- ============================================================
-- First, create the 'photos' bucket in Storage Dashboard (make it public)
-- Then run these policies:

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can upload own photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can view own photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own photos" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own photos" ON storage.objects;
DROP POLICY IF EXISTS "Public can view photos" ON storage.objects;

-- Allow users to upload their own photos
CREATE POLICY "Users can upload own photos" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'photos' AND 
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- Allow users to view their own photos
CREATE POLICY "Users can view own photos" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'photos' AND 
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- Allow users to update their own photos
CREATE POLICY "Users can update own photos" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'photos' AND 
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- Allow users to delete their own photos
CREATE POLICY "Users can delete own photos" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'photos' AND 
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- Allow public read access (since bucket is public)
CREATE POLICY "Public can view photos" ON storage.objects
  FOR SELECT USING (bucket_id = 'photos');

