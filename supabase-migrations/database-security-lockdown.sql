-- =============================================================================
-- Database security lockdown (auth_users_exposed, RLS disabled, rls_policy_always_true)
-- Run after other migrations. Idempotent.
-- =============================================================================
-- 4.1 Views that touch auth.users or are SECURITY DEFINER: not in public.
-- 4.2 RLS on all flagged public tables with explicit policies.
-- 4.3 user_stats: no WITH CHECK (true); only own-row access.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 4.1 auth_users_exposed + SECURITY DEFINER: no such views in public
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;

-- Remove any view in public that exposes auth.users or is definer (so anon can't see it).
DROP VIEW IF EXISTS public.user_activity_stats;
DROP VIEW IF EXISTS public.user_stats_with_usernames;

-- Ensure private copies exist (security_invoker = caller's privileges; only service_role should access private).
-- user_activity_stats: used by admin API with service_role; joins auth.users for email.
CREATE OR REPLACE VIEW private.user_activity_stats
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
LEFT JOIN public.scan_jobs  sj ON sj.user_id = p.id AND (sj.deleted_at IS NULL)
LEFT JOIN public.books      b  ON b.user_id  = p.id AND b.deleted_at IS NULL
GROUP BY p.id, p.username, p.display_name, u.email;

COMMENT ON VIEW private.user_activity_stats IS
  'Admin-only; query with service_role only. Do not expose private schema to PostgREST.';

-- user_stats_with_usernames: user_stats + username from profiles (no auth.users).
CREATE OR REPLACE VIEW private.user_stats_with_usernames
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
  'user_stats + username. In private schema; do not expose.';


-- -----------------------------------------------------------------------------
-- 4.2 RLS on flagged tables (explicit policies; server-only = no anon/authenticated access)
-- -----------------------------------------------------------------------------

-- scan_jobs: authenticated own rows only
ALTER TABLE scan_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "scan_jobs_select_own" ON scan_jobs;
DROP POLICY IF EXISTS "scan_jobs_insert_own" ON scan_jobs;
DROP POLICY IF EXISTS "scan_jobs_update_own" ON scan_jobs;
DROP POLICY IF EXISTS "scan_jobs_delete_own" ON scan_jobs;
CREATE POLICY "scan_jobs_select_own" ON scan_jobs FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
CREATE POLICY "scan_jobs_insert_own" ON scan_jobs FOR INSERT TO authenticated WITH CHECK (user_id = (select auth.uid()));
CREATE POLICY "scan_jobs_update_own" ON scan_jobs FOR UPDATE TO authenticated USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
CREATE POLICY "scan_jobs_delete_own" ON scan_jobs FOR DELETE TO authenticated USING (user_id = (select auth.uid()));

-- client_telemetry: INSERT only for anon (user_id null) / authenticated (own user_id or null); no SELECT for anon/authenticated
ALTER TABLE client_telemetry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "telemetry_no_direct_access" ON client_telemetry;
DROP POLICY IF EXISTS "telemetry_insert_only" ON client_telemetry;
DROP POLICY IF EXISTS "telemetry_insert_authenticated_own" ON client_telemetry;
CREATE POLICY "telemetry_insert_only" ON client_telemetry FOR INSERT TO anon WITH CHECK (user_id IS NULL);
CREATE POLICY "telemetry_insert_authenticated_own" ON client_telemetry FOR INSERT TO authenticated WITH CHECK (user_id IS NULL OR user_id = (select auth.uid())::text);
COMMENT ON COLUMN client_telemetry.session_id IS 'SHA-256 hash of raw session id (set by API); never store raw value.';

-- cover_resolutions: authenticated read-only (shared cache); write via service role only
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'cover_resolutions') THEN
    ALTER TABLE cover_resolutions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "cover_resolutions_authenticated_read" ON cover_resolutions;
    CREATE POLICY "cover_resolutions_authenticated_read" ON cover_resolutions FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- book_cover_cache: server-only (no anon/authenticated access)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'book_cover_cache') THEN
    ALTER TABLE book_cover_cache ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "book_cover_cache_no_direct_access" ON book_cover_cache;
    CREATE POLICY "book_cover_cache_no_direct_access" ON book_cover_cache AS RESTRICTIVE FOR ALL USING (false);
  END IF;
END $$;

-- cover_aliases: server-only
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'cover_aliases') THEN
    ALTER TABLE cover_aliases ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "cover_aliases_no_direct_access" ON cover_aliases;
    CREATE POLICY "cover_aliases_no_direct_access" ON cover_aliases AS RESTRICTIVE FOR ALL USING (false);
  END IF;
END $$;

-- public.users (if exists): own row only
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "users_select_own" ON users;
    DROP POLICY IF EXISTS "users_update_own" ON users;
    CREATE POLICY "users_select_own" ON users FOR SELECT TO authenticated USING (id = (select auth.uid()));
    CREATE POLICY "users_update_own" ON users FOR UPDATE TO authenticated USING (id = (select auth.uid())) WITH CHECK (id = (select auth.uid()));
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 4.3 user_stats: remove any WITH CHECK (true); only own-row read/insert/update/delete
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_stats') THEN
    ALTER TABLE user_stats ENABLE ROW LEVEL SECURITY;
    -- Drop every existing policy (removes "System can insert" / WITH CHECK (true) etc.)
    FOR r IN (SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_stats')
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.user_stats', r.policyname);
    END LOOP;
    -- Single policy: authenticated can only access their own row (user_id = auth.uid())
    CREATE POLICY "user_stats_own_row_only" ON user_stats
      FOR ALL TO authenticated
      USING (user_id = (select auth.uid()))
      WITH CHECK (user_id = (select auth.uid()));
    -- anon: no access. Server/system writes use service role and bypass RLS.
  END IF;
END $$;
