-- Add read_at column to books table
-- Run this in your Supabase SQL Editor if the read_at column doesn't exist
-- This enables tracking which books have been marked as read

-- Add read_at column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'books' 
    AND column_name = 'read_at'
  ) THEN
    ALTER TABLE public.books 
    ADD COLUMN read_at BIGINT;
    
    -- Add comment to document the column
    COMMENT ON COLUMN public.books.read_at IS 'Timestamp when book was marked as read (null if not read)';
    
    -- Create index for faster queries on read status
    CREATE INDEX IF NOT EXISTS idx_books_user_id_read_at 
    ON public.books(user_id, read_at);
    
    RAISE NOTICE 'read_at column added successfully';
  ELSE
    RAISE NOTICE 'read_at column already exists';
  END IF;
END $$;



