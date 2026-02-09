-- Migration: Fix books.user_id FK to reference auth.users(id) directly
-- Goal: Make books.user_id reference auth.users(id) instead of profiles or public.users
-- Date: 2026-02-04
--
-- This migration:
-- 1. Drops any existing FK constraint on books.user_id (public.users, profiles, etc.)
-- 2. Creates FK constraint from books.user_id to auth.users(id) with ON DELETE CASCADE
-- 3. Ensures consistency - all user_id columns should reference auth.users(id)

-- Step 1: Check if books table exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'books') THEN
    RAISE EXCEPTION 'books table does not exist. Please create it first.';
  END IF;
END $$;

-- Step 2: Drop any existing FK constraint on books.user_id that references wrong tables
DO $$
DECLARE
  constraint_name TEXT;
  target_table TEXT;
BEGIN
  -- Find any FK constraint on books.user_id
  SELECT conname, confrelid::regclass::text INTO constraint_name, target_table
  FROM pg_constraint
  WHERE conrelid = 'public.books'::regclass
    AND contype = 'f'
    AND conkey::text LIKE '%user_id%';
  
  IF constraint_name IS NOT NULL THEN
    -- Drop the constraint regardless of what it references
    EXECUTE format('ALTER TABLE public.books DROP CONSTRAINT IF EXISTS %I', constraint_name);
    RAISE NOTICE 'Dropped existing FK constraint: % (was pointing to %)', constraint_name, target_table;
  ELSE
    RAISE NOTICE 'No existing FK constraint found on books.user_id';
  END IF;
END $$;

-- Step 3: Drop constraint by name if it exists (in case Step 2 didn't catch it)
ALTER TABLE public.books
  DROP CONSTRAINT IF EXISTS books_user_id_fkey;

-- Step 4: Add FK constraint from books.user_id to auth.users(id) with ON DELETE CASCADE
ALTER TABLE public.books
  ADD CONSTRAINT books_user_id_fkey 
    FOREIGN KEY (user_id) 
    REFERENCES auth.users(id) 
    ON DELETE CASCADE;

-- Step 5: Verify the constraint was created correctly
DO $$
DECLARE
  constraint_exists BOOLEAN;
  constraint_name TEXT;
  target_table TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.books'::regclass
      AND confrelid = 'auth.users'::regclass
      AND contype = 'f'
      AND conkey::text LIKE '%user_id%'
  ) INTO constraint_exists;
  
  IF constraint_exists THEN
    -- Get the constraint details
    SELECT conname, confrelid::regclass::text INTO constraint_name, target_table
    FROM pg_constraint
    WHERE conrelid = 'public.books'::regclass
      AND confrelid = 'auth.users'::regclass
      AND contype = 'f'
      AND conkey::text LIKE '%user_id%'
    LIMIT 1;
    
    RAISE NOTICE '✅ Successfully created FK constraint: books.user_id -> auth.users(id) with ON DELETE CASCADE';
    RAISE NOTICE 'Constraint name: %', constraint_name;
    RAISE NOTICE 'Target table: %', target_table;
  ELSE
    RAISE WARNING '⚠️ FK constraint may not have been created correctly';
  END IF;
END $$;

-- Step 6: Verify no other FK constraints exist on books.user_id
DO $$
DECLARE
  constraint_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO constraint_count
  FROM pg_constraint
  WHERE conrelid = 'public.books'::regclass
    AND contype = 'f'
    AND conkey::text LIKE '%user_id%';
  
  IF constraint_count = 1 THEN
    RAISE NOTICE '✅ Exactly one FK constraint exists on books.user_id (as expected)';
  ELSIF constraint_count = 0 THEN
    RAISE WARNING '⚠️ No FK constraint found on books.user_id';
  ELSE
    RAISE WARNING '⚠️ Multiple FK constraints found on books.user_id (expected 1, found %)', constraint_count;
  END IF;
END $$;

-- Step 7: Add comment documenting the change
COMMENT ON CONSTRAINT books_user_id_fkey ON public.books IS 
  'Foreign key to auth.users table. books.user_id references auth.users(id) with ON DELETE CASCADE. This is the source of truth for user identity.';

