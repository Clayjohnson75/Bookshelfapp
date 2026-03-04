-- Atomic "Delete library photo" with two cascade modes.
-- Called from API with authed user id; validates photo belongs to that user.
--
-- p_cascade_books behaviour:
--   true  -> soft-delete books WHERE source_photo_id = p_photo_id (user chose "Delete photo + books")
--   false -> NULL OUT source_photo_id on those books so they are detached but NOT deleted
--            (user chose "Delete photo only" — books keep their own lifecycle)
--
-- Returns: { ok, deleted_books, nulled_books, deleted_photo, storage_path }
--   deleted_books  number of books soft-deleted (cascade=true path)
--   nulled_books   number of books detached (cascade=false path)
--   deleted_photo  1 if photo row was soft-deleted, else 0
--   storage_path   value to pass to storage.remove() after the RPC

CREATE OR REPLACE FUNCTION delete_library_photo_and_books(
  p_photo_id uuid,
  p_cascade_books boolean DEFAULT false,
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_photo       public.photos%ROWTYPE;
  v_deleted_books bigint := 0;
  v_nulled_books  bigint := 0;
  v_now         timestamptz := now();
  v_storage_path text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'user_required',
      'deleted_books', 0, 'nulled_books', 0, 'deleted_photo', 0, 'storage_path', null
    );
  END IF;

  -- 1) Fetch photo row and verify ownership (FOR UPDATE holds row lock in transaction)
  SELECT * INTO v_photo
  FROM public.photos
  WHERE id = p_photo_id
    AND user_id = p_user_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'photo_not_found',
      'deleted_books', 0, 'nulled_books', 0, 'deleted_photo', 0, 'storage_path', null
    );
  END IF;

  v_storage_path := v_photo.storage_path;

  IF p_cascade_books THEN
    -- 2a) Cascade: soft-delete books tied to this photo.
    --     User explicitly chose "Delete photo and books".
    WITH updated AS (
      UPDATE public.books
      SET deleted_at = v_now, updated_at = v_now
      WHERE source_photo_id = p_photo_id
        AND user_id = p_user_id
        AND deleted_at IS NULL
      RETURNING id
    )
    SELECT count(*) INTO v_deleted_books FROM updated;
  ELSE
    -- 2b) No cascade: detach books by nulling source_photo_id.
    --     Books keep their approved/pending status and remain in the library.
    WITH updated AS (
      UPDATE public.books
      SET source_photo_id = NULL, updated_at = v_now
      WHERE source_photo_id = p_photo_id
        AND user_id = p_user_id
        AND deleted_at IS NULL
      RETURNING id
    )
    SELECT count(*) INTO v_nulled_books FROM updated;
  END IF;

  -- 3) Soft-delete photo row
  UPDATE public.photos
  SET deleted_at = v_now, updated_at = v_now
  WHERE id = p_photo_id;

  RETURN jsonb_build_object(
    'ok',            true,
    'deleted_books', v_deleted_books,
    'nulled_books',  v_nulled_books,
    'deleted_photo', 1,
    'storage_path',  v_storage_path
  );
END;
$$;

COMMENT ON FUNCTION delete_library_photo_and_books(uuid, boolean, uuid) IS
  'Soft-delete a photo. When p_cascade_books=true also soft-deletes its books (user chose "Delete photo + books"). '
  'When p_cascade_books=false (default) detaches books by nulling source_photo_id — books survive with their own lifecycle. '
  'Caller must delete storage object using returned storage_path.';
