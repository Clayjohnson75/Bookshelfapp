-- Migration: Fix books.user_id FK to reference profiles(id) instead of users(id)
-- Goal: Stop using public.users entirely, use public.profiles
-- Date: 2026-02-04

-- Step 1: Drop existing FK constraint if it references users
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  -- Find the FK constraint on books.user_id that references users
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.books'::regclass
    AND confrelid = 'public.users'::regclass
    AND contype = 'f'
    AND conkey::text LIKE '%user_id%';
  
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.books DROP CONSTRAINT IF EXISTS %I', constraint_name);
    RAISE NOTICE 'Dropped FK constraint: %', constraint_name;
  ELSE
    RAISE NOTICE 'No FK constraint found from books.user_id to users';
  END IF;
END $$;

-- Step 2: Create FK constraint to profiles(id) instead
-- First, ensure profiles table exists (it should, but check)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'profiles') THEN
    RAISE EXCEPTION 'profiles table does not exist. Please create it first.';
  END IF;
END $$;

-- Add FK constraint from books.user_id to profiles(id)
ALTER TABLE public.books
  DROP CONSTRAINT IF EXISTS books_user_id_fkey,
  ADD CONSTRAINT books_user_id_fkey 
    FOREIGN KEY (user_id) 
    REFERENCES public.profiles(id) 
    ON DELETE CASCADE;

-- Step 3: Verify the constraint was created
DO $$
DECLARE
  constraint_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.books'::regclass
      AND confrelid = 'public.profiles'::regclass
      AND contype = 'f'
      AND conkey::text LIKE '%user_id%'
  ) INTO constraint_exists;
  
  IF constraint_exists THEN
    RAISE NOTICE '✅ Successfully created FK constraint: books.user_id -> profiles(id)';
  ELSE
    RAISE WARNING '⚠️ FK constraint may not have been created correctly';
  END IF;
END $$;

-- Step 4: Add comment documenting the change
COMMENT ON CONSTRAINT books_user_id_fkey ON public.books IS 
  'Foreign key to profiles table. books.user_id references profiles(id), not users(id).';


