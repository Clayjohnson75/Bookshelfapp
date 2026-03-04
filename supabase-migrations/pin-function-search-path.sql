-- =============================================================================
-- function_search_path_mutable (WARN): Pin search_path on all functions
-- =============================================================================
-- Unqualified names resolve via search_path; a mutable or missing search_path
-- can allow name-resolution attacks (e.g. malicious object in earlier schema).
-- SECURITY DEFINER functions are higher risk; pinning is best practice for all.
-- Extra hardening: in CREATE FUNCTION bodies we schema-qualify tables (public.*).
-- =============================================================================

-- Trigger: photos complete -> create scan_job (SECURITY DEFINER)
ALTER FUNCTION public.photos_uploaded_create_scan_job()
  SET search_path = pg_catalog, public;

-- Trigger: mirror scan_jobs.id into job_uuid
ALTER FUNCTION public.scan_jobs_set_job_uuid()
  SET search_path = pg_catalog, public;

-- RPC: soft-delete photo and optionally cascade to books (SECURITY DEFINER)
ALTER FUNCTION public.delete_library_photo_and_books(uuid, boolean, uuid)
  SET search_path = pg_catalog, public;

-- RPC: approve pending books and close scan jobs (SECURITY DEFINER)
ALTER FUNCTION public.approve_scan_job(uuid, text[])
  SET search_path = pg_catalog, public;

-- Trigger: cascade photo soft-delete to books (SECURITY DEFINER)
ALTER FUNCTION public.photos_soft_delete_cascade_books()
  SET search_path = pg_catalog, public;
