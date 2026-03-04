-- Enforce cascade when a photo is soft-deleted: books with source_photo_id = that photo
-- must be soft-deleted too. This makes it impossible for the client to send cascadeBooks=false
-- (e.g. when books snapshot returned 0) and leave orphaned books behind.
--
-- When photos.deleted_at changes from null to non-null:
--   UPDATE books SET deleted_at = NEW.deleted_at, updated_at = NEW.updated_at
--   WHERE source_photo_id = NEW.id AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION photos_soft_delete_cascade_books()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE public.books
    SET deleted_at = NEW.deleted_at,
        updated_at = COALESCE(NEW.updated_at, now())
    WHERE source_photo_id = NEW.id
      AND user_id = NEW.user_id
      AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS photos_soft_delete_cascade_books_trigger ON photos;
CREATE TRIGGER photos_soft_delete_cascade_books_trigger
  AFTER UPDATE OF deleted_at ON photos
  FOR EACH ROW
  EXECUTE PROCEDURE photos_soft_delete_cascade_books();

COMMENT ON FUNCTION photos_soft_delete_cascade_books() IS
  'When a photo is soft-deleted (deleted_at set), soft-delete all books that reference it (source_photo_id). '
  'Ensures cascade even when client sends cascadeBooks=false due to empty/untrusted book count.';

-- Update RPC so cascadeBooks=false does not null source_photo_id; we soft-delete the photo and the trigger cascades to books.
-- Otherwise when client sends cascadeBooks=false (e.g. book count was 0), we would null source_photo_id then soft-delete photo,
-- and the trigger would find no books to cascade to.
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
  v_book_count    bigint;
  v_now         timestamptz := now();
  v_storage_path text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'user_required',
      'deleted_books', 0, 'nulled_books', 0, 'deleted_photo', 0, 'storage_path', null
    );
  END IF;

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
    -- Explicit cascade: soft-delete books tied to this photo (trigger will run on photo but find 0 to update).
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
    -- Do NOT null source_photo_id. Soft-delete the photo; trigger photos_soft_delete_cascade_books_trigger
    -- will cascade soft-delete to books. This fixes the bug where client sends cascadeBooks=false
    -- (e.g. book count was 0) and books were left behind.
    SELECT count(*) INTO v_book_count
    FROM public.books
    WHERE source_photo_id = p_photo_id
      AND user_id = p_user_id
      AND deleted_at IS NULL;
    v_deleted_books := v_book_count;
  END IF;

  -- Soft-delete photo row (trigger cascades to books when cascadeBooks=false)
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
  'Soft-delete a photo. Trigger photos_soft_delete_cascade_books_trigger always cascades soft-delete to books when photo.deleted_at is set. '
  'When p_cascade_books=true the RPC also soft-deletes books before updating the photo (same outcome). '
  'When p_cascade_books=false the RPC only soft-deletes the photo; the trigger cascades to books so books are never left behind. '
  'Caller must delete storage object using returned storage_path.';
