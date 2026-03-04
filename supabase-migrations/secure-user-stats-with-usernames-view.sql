-- =============================================================================
-- SECURITY: Move user_stats_with_usernames out of public, use SECURITY INVOKER
-- =============================================================================
-- Problem: public.user_stats_with_usernames is a SECURITY DEFINER view; it can
-- bypass table RLS and leak rows/columns. Same class of risk as user_activity_stats.
-- Fix: Drop from public, recreate in private schema with security_invoker = true.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS private;

-- Remove the definer view from the exposed public schema.
DROP VIEW IF EXISTS public.user_stats_with_usernames;

-- Recreate in private with caller's privileges. Definition below matches the
-- typical shape (user_stats + username from profiles). If your live view has
-- different columns, run this in SQL first and paste the result into the AS clause:
--   SELECT pg_get_viewdef('user_stats_with_usernames'::regclass, true);
CREATE VIEW private.user_stats_with_usernames
WITH (security_invoker = true)
AS
SELECT
  s.user_id,
  s.total_scans,
  s.monthly_scans,
  s.last_scan_at,
  s.updated_at,
  p.username
FROM public.user_stats s
LEFT JOIN public.profiles p ON p.id = s.user_id;

COMMENT ON VIEW private.user_stats_with_usernames IS
  'user_stats plus username. In private schema with security_invoker; do not expose.';
