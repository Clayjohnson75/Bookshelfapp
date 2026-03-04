-- =============================================================================
-- SECURITY: Move user_activity_stats out of public and fix definer exposure
-- =============================================================================
-- Problem: public.user_activity_stats (1) joins auth.users (email), (2) was
-- exposed to anon, (3) SECURITY DEFINER could bypass caller restrictions.
-- Fix: Create view in non-exposed schema (private), use SECURITY INVOKER,
-- and ensure only service_role can use it. Do NOT grant anon/authenticated
-- on private schema so the view is never reachable from the public API.
-- =============================================================================

-- Ensure private schema exists (Supabase may create it; idempotent).
CREATE SCHEMA IF NOT EXISTS private;

-- Drop the public view so it is no longer exposed to anon.
DROP VIEW IF EXISTS public.user_activity_stats;

-- Recreate in private schema with SECURITY INVOKER (caller's privileges).
-- Only server-side code using service_role should query this (e.g. GET /api/admin/user-stats).
-- We keep the auth.users join for admin email display; access is restricted by schema exposure.
CREATE VIEW private.user_activity_stats
WITH (security_invoker = true)
AS
SELECT
  p.id                                                          AS user_id,
  p.username,
  p.display_name,
  u.email,
  COUNT(DISTINCT sj.id) FILTER (WHERE sj.status = 'completed') AS total_completed_scans,
  COUNT(DISTINCT sj.id) FILTER (
    WHERE sj.status = 'completed'
      AND sj.created_at >= (now() - INTERVAL '7 days')
  )                                                             AS scans_last_7d,
  COUNT(DISTINCT sj.id) FILTER (
    WHERE sj.status = 'completed'
      AND sj.created_at >= (now() - INTERVAL '30 days')
  )                                                             AS scans_last_30d,
  COUNT(DISTINCT b.id) FILTER (WHERE b.deleted_at IS NULL)     AS total_books
FROM public.profiles p
LEFT JOIN auth.users u  ON u.id  = p.id
LEFT JOIN public.scan_jobs  sj ON sj.user_id = p.id AND sj.deleted_at IS NULL
LEFT JOIN public.books      b  ON b.user_id  = p.id AND b.deleted_at IS NULL
GROUP BY p.id, p.username, p.display_name, u.email;

COMMENT ON VIEW private.user_activity_stats IS
  'Admin-only activity stats. Only query from server with service_role; do not expose private schema to API.';
