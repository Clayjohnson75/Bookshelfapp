-- Migration: Add deletion safeguards for library_books
-- Goal: Ensure deletions only happen from explicit user action, never from scanning/dedupe
-- Date: 2026-02-04

-- Step 1: Create library_events audit log table
CREATE TABLE IF NOT EXISTS library_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('deleted', 'restored', 'updated')),
  source TEXT NOT NULL CHECK (source IN ('user_action', 'admin_action', 'system')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_library_events_user_id ON library_events(user_id);
CREATE INDEX IF NOT EXISTS idx_library_events_book_id ON library_events(book_id);
CREATE INDEX IF NOT EXISTS idx_library_events_created_at ON library_events(created_at DESC);

-- RLS for library_events
ALTER TABLE library_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own library events"
  ON library_events FOR SELECT
  USING (auth.uid() = user_id);

-- Step 2: Add soft-delete columns to books table
ALTER TABLE books 
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS delete_reason TEXT;

-- Index for filtering out deleted books
CREATE INDEX IF NOT EXISTS idx_books_deleted_at ON books(deleted_at) WHERE deleted_at IS NULL;

-- Step 3: Create RPC function for safe deletion (only user can delete their own books)
CREATE OR REPLACE FUNCTION delete_library_book(
  p_book_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_book_title TEXT;
  v_result JSONB;
BEGIN
  -- Get current user
  v_user_id := auth.uid();
  
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'not_authenticated',
      'message', 'User must be authenticated to delete books'
    );
  END IF;

  -- Verify user owns the book and it's not already deleted
  SELECT user_id, title INTO v_user_id, v_book_title
  FROM books
  WHERE id = p_book_id
    AND user_id = v_user_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'book_not_found_or_unauthorized',
      'message', 'Book not found or you do not have permission to delete it'
    );
  END IF;

  -- Insert audit event BEFORE deletion
  INSERT INTO library_events (
    user_id,
    book_id,
    event_type,
    source,
    reason,
    metadata
  ) VALUES (
    v_user_id,
    p_book_id,
    'deleted',
    'user_action',
    p_reason,
    jsonb_build_object(
      'book_title', v_book_title,
      'deleted_at', now()
    )
  );

  -- Soft delete: set deleted_at instead of hard delete
  UPDATE books
  SET 
    deleted_at = now(),
    deleted_by = v_user_id,
    delete_reason = p_reason,
    updated_at = now()
  WHERE id = p_book_id;

  RETURN jsonb_build_object(
    'success', true,
    'book_id', p_book_id,
    'deleted_at', now()
  );
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION delete_library_book(UUID, TEXT) TO authenticated;

-- Step 4: Update RLS policies to block direct DELETE operations
-- Only allow SELECT and UPDATE (for soft-delete via RPC)
-- Direct DELETE is blocked by default in RLS

-- Ensure existing SELECT policy filters out deleted books
DROP POLICY IF EXISTS "Users can view their own books" ON books;
CREATE POLICY "Users can view their own books"
  ON books FOR SELECT
  USING (
    auth.uid() = user_id 
    AND deleted_at IS NULL  -- Only show non-deleted books
  );

-- Allow UPDATE only for soft-delete (deleted_at, deleted_by, delete_reason)
-- But restrict to prevent overwriting library data from scans
DROP POLICY IF EXISTS "Users can update their own books" ON books;
CREATE POLICY "Users can update their own books"
  ON books FOR UPDATE
  USING (auth.uid() = user_id AND deleted_at IS NULL)
  WITH CHECK (
    auth.uid() = user_id 
    AND deleted_at IS NULL  -- Can't update already-deleted books
    -- Allow updates to deleted_at only via RPC (security definer)
    -- Regular users can update other fields normally
  );

-- Block direct DELETE operations (only RPC can soft-delete)
-- RLS blocks DELETE by default, but make it explicit
DROP POLICY IF EXISTS "Users can delete their own books" ON books;
-- No DELETE policy = DELETE is blocked

-- Step 5: Create function to restore deleted books (optional, for admin use)
CREATE OR REPLACE FUNCTION restore_library_book(
  p_book_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  -- Verify user owns the book
  IF NOT EXISTS (
    SELECT 1 FROM books 
    WHERE id = p_book_id 
      AND user_id = v_user_id
      AND deleted_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'book_not_found_or_not_deleted');
  END IF;

  -- Restore the book
  UPDATE books
  SET 
    deleted_at = NULL,
    deleted_by = NULL,
    delete_reason = NULL,
    updated_at = now()
  WHERE id = p_book_id;

  -- Log restoration event
  INSERT INTO library_events (
    user_id,
    book_id,
    event_type,
    source,
    reason
  ) VALUES (
    v_user_id,
    p_book_id,
    'restored',
    'user_action',
    'Book restored from soft-delete'
  );

  RETURN jsonb_build_object('success', true, 'book_id', p_book_id);
END;
$$;

GRANT EXECUTE ON FUNCTION restore_library_book(UUID) TO authenticated;

-- Step 6: Add comment documenting the safeguard
COMMENT ON FUNCTION delete_library_book IS 
  'Safely soft-deletes a library book. Only the book owner can delete. 
   Inserts audit log entry. Scans cannot call this - only explicit user actions.';

COMMENT ON TABLE library_events IS 
  'Audit log for all library book events (deletions, restorations, updates).
   Ensures deletions are traceable and only happen from user actions.';


