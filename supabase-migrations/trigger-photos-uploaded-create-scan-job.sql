-- When a photos row has status = 'complete' and storage_path set (upload done), create a scan_job row
-- so the server has a job to run. Uses 'complete' (not 'uploaded') so we never rely on a status
-- that may be disallowed by photos_status_check (draft|complete|discarded).
-- Creates at most one scan_job per photo_id (skips if one already exists).

CREATE OR REPLACE FUNCTION photos_uploaded_create_scan_job()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job_id uuid;
  v_scan_id text;
BEGIN
  -- Only when status is 'complete' and storage_path is set
  IF NEW.status <> 'complete' OR NEW.storage_path IS NULL OR trim(NEW.storage_path) = '' THEN
    RETURN NEW;
  END IF;

  -- On UPDATE, only when status actually changed to complete (avoid re-running when worker sets complete)
  IF TG_OP = 'UPDATE' AND OLD.status = 'complete' THEN
    RETURN NEW;
  END IF;

  -- Do not create a second job if one already exists for this photo
  IF EXISTS (
    SELECT 1 FROM public.scan_jobs
    WHERE photo_id = NEW.id
      AND deleted_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  v_job_id := gen_random_uuid();
  v_scan_id := 'scan_' || replace(v_job_id::text, '-', '');

  INSERT INTO public.scan_jobs (
    id,
    user_id,
    photo_id,
    image_path,
    status,
    stage,
    progress,
    books,
    scan_id,
    created_at,
    updated_at
  ) VALUES (
    v_job_id,
    NEW.user_id,
    NEW.id,
    NEW.storage_path,
    'pending',
    'queued',
    0,
    '[]'::jsonb,
    v_scan_id,
    now(),
    now()
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS photos_uploaded_create_scan_job_trigger ON photos;
CREATE TRIGGER photos_uploaded_create_scan_job_trigger
  AFTER INSERT OR UPDATE OF status, storage_path
  ON photos
  FOR EACH ROW
  EXECUTE FUNCTION photos_uploaded_create_scan_job();

COMMENT ON FUNCTION photos_uploaded_create_scan_job() IS
  'When photos.status becomes complete and storage_path is set, insert a scan_job row (pending) so the server can run the job. Idempotent: skips if a scan_job for this photo_id already exists. Uses complete (not uploaded) for strict DB constraint.';
