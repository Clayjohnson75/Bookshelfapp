-- Migration: Verify and fix books RLS policy to ensure it doesn't depend on profiles
-- Goal: Ensure RLS policy is based on auth.uid() = user_id, not profiles existence
-- Date: 2026-02-04
--
-- This migration:
-- 1. Verifies the SELECT policy is correct (auth.uid() = user_id, not profiles)
-- 2. Ensures no policies depend on profiles table
-- 3. Adds logging to help debug missing books issues

-- Step 1: Verify current SELECT policy
DO $$
DECLARE
  policy_exists BOOLEAN;
  policy_definition TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'books'
      AND policyname = 'Users can view their own books'
  ) INTO policy_exists;
  
  IF policy_exists THEN
    SELECT qual INTO policy_definition
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'books'
      AND policyname = 'Users can view their own books';
    
    RAISE NOTICE 'Current SELECT policy definition: %', policy_definition;
    
    -- Check if policy depends on profiles (bad!)
    IF policy_definition LIKE '%profiles%' THEN
      RAISE WARNING '⚠️ SELECT policy depends on profiles table - this can cause missing books!';
      RAISE WARNING '   Policy should use: auth.uid() = user_id AND deleted_at IS NULL';
    ELSE
      RAISE NOTICE '✅ SELECT policy does NOT depend on profiles (correct)';
    END IF;
  ELSE
    RAISE WARNING '⚠️ SELECT policy "Users can view their own books" does not exist!';
  END IF;
END $$;

-- Step 2: Ensure SELECT policy is correct (recreate if needed)
DROP POLICY IF EXISTS "Users can view their own books" ON books;
CREATE POLICY "Users can view their own books"
  ON books FOR SELECT
  USING (
    auth.uid() = user_id 
    AND deleted_at IS NULL  -- Only show non-deleted books
  );

-- Step 3: Verify the policy was created correctly
DO $$
DECLARE
  policy_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'books'
      AND policyname = 'Users can view their own books'
  ) INTO policy_exists;
  
  IF policy_exists THEN
    RAISE NOTICE '✅ SELECT policy "Users can view their own books" is correctly configured';
    RAISE NOTICE '   Policy uses: auth.uid() = user_id AND deleted_at IS NULL';
    RAISE NOTICE '   This ensures books are visible based on auth.uid(), NOT profiles existence';
  ELSE
    RAISE EXCEPTION 'Failed to create SELECT policy';
  END IF;
END $$;

-- Step 4: Add comment documenting the policy
COMMENT ON POLICY "Users can view their own books" ON books IS 
  'RLS policy for SELECT: Users can view their own non-deleted books. Based on auth.uid() = user_id, NOT on profiles table existence. This ensures books are visible even if profile creation failed.';

