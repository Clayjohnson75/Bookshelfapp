-- ============================================================
-- BOOKSHELF SCANNER - Add Book Stats Fields Migration
-- ============================================================
-- Copy and paste this entire file into your Supabase SQL Editor
-- This adds Google Books API stats fields to the books table
-- ============================================================

-- Add new columns for book statistics from Google Books API
ALTER TABLE public.books 
  ADD COLUMN IF NOT EXISTS page_count INTEGER,
  ADD COLUMN IF NOT EXISTS categories TEXT[], -- Array of genre/category strings
  ADD COLUMN IF NOT EXISTS publisher TEXT,
  ADD COLUMN IF NOT EXISTS published_date TEXT, -- Store as text to handle various formats
  ADD COLUMN IF NOT EXISTS language TEXT,
  ADD COLUMN IF NOT EXISTS average_rating NUMERIC(3,2), -- Decimal for ratings like 4.5
  ADD COLUMN IF NOT EXISTS ratings_count INTEGER,
  ADD COLUMN IF NOT EXISTS subtitle TEXT,
  ADD COLUMN IF NOT EXISTS print_type TEXT;

-- Create indexes for faster stats queries
CREATE INDEX IF NOT EXISTS idx_books_page_count ON public.books(page_count) WHERE page_count IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_books_published_date ON public.books(published_date) WHERE published_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_books_publisher ON public.books(publisher) WHERE publisher IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_books_language ON public.books(language) WHERE language IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_books_average_rating ON public.books(average_rating) WHERE average_rating IS NOT NULL;

-- Add comment
COMMENT ON COLUMN public.books.page_count IS 'Total number of pages from Google Books API';
COMMENT ON COLUMN public.books.categories IS 'Array of genres/categories from Google Books API';
COMMENT ON COLUMN public.books.publisher IS 'Publisher name from Google Books API';
COMMENT ON COLUMN public.books.published_date IS 'Publication date from Google Books API';
COMMENT ON COLUMN public.books.language IS 'Language code from Google Books API';
COMMENT ON COLUMN public.books.average_rating IS 'Average rating (0-5) from Google Books API';
COMMENT ON COLUMN public.books.ratings_count IS 'Total number of ratings from Google Books API';
COMMENT ON COLUMN public.books.subtitle IS 'Book subtitle from Google Books API';
COMMENT ON COLUMN public.books.print_type IS 'Print type (e.g., BOOK) from Google Books API';






