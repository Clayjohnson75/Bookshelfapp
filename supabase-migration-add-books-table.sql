-- Create books table to store user's books with read status
-- Run this in your Supabase SQL Editor
-- This enables cross-device synchronization of book read status

CREATE TABLE IF NOT EXISTS public.books (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  isbn TEXT,
  confidence TEXT,
  status TEXT CHECK (status IN ('pending', 'approved', 'rejected', 'incomplete')),
  scanned_at BIGINT,
  cover_url TEXT,
  local_cover_path TEXT,
  google_books_id TEXT,
  description TEXT,
  read_at BIGINT, -- Timestamp when book was marked as read (null if not read)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_books_user_id ON public.books(user_id);
CREATE INDEX IF NOT EXISTS idx_books_user_id_read_at ON public.books(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_books_user_id_status ON public.books(user_id, status);

-- Create unique constraint for one book per user (by title + author)
-- Use a partial unique index that handles null authors by using empty string
CREATE UNIQUE INDEX IF NOT EXISTS idx_books_user_title_author_unique 
  ON public.books(user_id, title, COALESCE(author, ''));

-- Enable RLS (Row Level Security)
ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;

-- Allow users to read their own books
CREATE POLICY "Users can view own books" ON public.books
  FOR SELECT USING (auth.uid() = user_id);

-- Allow users to insert their own books
CREATE POLICY "Users can insert own books" ON public.books
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Allow users to update their own books
CREATE POLICY "Users can update own books" ON public.books
  FOR UPDATE USING (auth.uid() = user_id);

-- Allow users to delete their own books
CREATE POLICY "Users can delete own books" ON public.books
  FOR DELETE USING (auth.uid() = user_id);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_books_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update updated_at on book updates
DROP TRIGGER IF EXISTS trigger_update_books_updated_at ON public.books;
CREATE TRIGGER trigger_update_books_updated_at
  BEFORE UPDATE ON public.books
  FOR EACH ROW
  EXECUTE FUNCTION public.update_books_updated_at();

