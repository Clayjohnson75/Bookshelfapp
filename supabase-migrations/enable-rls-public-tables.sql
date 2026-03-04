-- =============================================================================
-- RLS on exposed public tables (rls_disabled_in_public / 0013)
-- =============================================================================
-- PostgREST exposes public schema; tables without RLS are a footgun.
-- Enable RLS and add explicit policies so anon/authenticated only see allowed rows.
-- Service role bypasses RLS for all API routes that use it.
-- Trigger photos_uploaded_create_scan_job (SECURITY DEFINER) bypasses RLS when inserting.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- scan_jobs: user can read/insert/update only their own jobs. (select auth.uid()) = initplan for perf.
-- Trigger and server APIs use service role; client sync/ScansTab use user JWT.
-- -----------------------------------------------------------------------------
ALTER TABLE scan_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scan_jobs_select_own" ON scan_jobs;
CREATE POLICY "scan_jobs_select_own" ON scan_jobs
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "scan_jobs_insert_own" ON scan_jobs;
CREATE POLICY "scan_jobs_insert_own" ON scan_jobs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "scan_jobs_update_own" ON scan_jobs;
CREATE POLICY "scan_jobs_update_own" ON scan_jobs
  FOR UPDATE TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "scan_jobs_delete_own" ON scan_jobs;
CREATE POLICY "scan_jobs_delete_own" ON scan_jobs
  FOR DELETE TO authenticated
  USING (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- books: multiple_permissive_policies (WARN) + anon UPDATE is a security hole.
-- Audit: select policyname, polcmd, polroles, polqual, polwithcheck from pg_policies
--   where schemaname='public' and tablename='books' order by polcmd, policyname;
-- Intent: no anon access. authenticated can only read/insert/update/delete own rows (user_id).
-- One policy per role/action to avoid multiple permissive policies.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'books') THEN
    ALTER TABLE books ENABLE ROW LEVEL SECURITY;
    -- Drop every existing policy (removes anon UPDATE and consolidates duplicates).
    FOR r IN (SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'books')
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.books', r.policyname);
    END LOOP;
    -- Single policy per action, authenticated only, own rows. Initplan for perf.
    CREATE POLICY "books_select_own" ON books
      FOR SELECT TO authenticated
      USING (user_id = (select auth.uid()));
    CREATE POLICY "books_insert_own" ON books
      FOR INSERT TO authenticated
      WITH CHECK (user_id = (select auth.uid()));
    CREATE POLICY "books_update_own" ON books
      FOR UPDATE TO authenticated
      USING (user_id = (select auth.uid()))
      WITH CHECK (user_id = (select auth.uid()));
    CREATE POLICY "books_delete_own" ON books
      FOR DELETE TO authenticated
      USING (user_id = (select auth.uid()));
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- cover_resolutions: shared cache by work_key. Client may read (e.g. ScansTab
-- fetches by work_key); writes are server-only (worker/API with service role).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'cover_resolutions') THEN
    ALTER TABLE cover_resolutions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "cover_resolutions_authenticated_read" ON cover_resolutions;
    CREATE POLICY "cover_resolutions_authenticated_read" ON cover_resolutions
      FOR SELECT TO authenticated
      USING (true);
    -- No INSERT/UPDATE/DELETE for anon/authenticated; service role only.
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- cover_resolution_books: links book_id -> work_key. Server/API only; no client direct access.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'cover_resolution_books') THEN
    ALTER TABLE cover_resolution_books ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "cover_resolution_books_no_direct_access" ON cover_resolution_books;
    CREATE POLICY "cover_resolution_books_no_direct_access" ON cover_resolution_books
      AS RESTRICTIVE FOR ALL
      USING (false);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- client_telemetry: sensitive_columns_exposed (0023) — session_id must not be
-- readable by clients. Allow INSERT only (anon/authenticated); disallow SELECT.
-- rls_policy_always_true: do not use WITH CHECK (true) — restrict to own user_id.
-- API hashes session_id before insert; only service role reads for analytics.
-- Idempotent with enable-rls-telemetry-cache.sql.
-- -----------------------------------------------------------------------------
ALTER TABLE client_telemetry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "telemetry_no_direct_access" ON client_telemetry;
DROP POLICY IF EXISTS "telemetry_insert_only" ON client_telemetry;
DROP POLICY IF EXISTS "telemetry_insert_authenticated_own" ON client_telemetry;
-- anon: may only insert rows with user_id IS NULL (pre-login). authenticated: only own user_id or null.
CREATE POLICY "telemetry_insert_only" ON client_telemetry
  FOR INSERT TO anon
  WITH CHECK (user_id IS NULL);
CREATE POLICY "telemetry_insert_authenticated_own" ON client_telemetry
  FOR INSERT TO authenticated
  WITH CHECK (user_id IS NULL OR user_id = (select auth.uid())::text);
-- No SELECT/UPDATE/DELETE policy for anon/authenticated → default deny; only service_role can read.
COMMENT ON COLUMN client_telemetry.session_id IS 'SHA-256 hash of raw session id (set by API); never store raw value (0023).';

-- -----------------------------------------------------------------------------
-- book_cover_cache (if exists): server-only; no direct client access.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'book_cover_cache') THEN
    ALTER TABLE book_cover_cache ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "book_cover_cache_no_direct_access" ON book_cover_cache;
    CREATE POLICY "book_cover_cache_no_direct_access" ON book_cover_cache
      AS RESTRICTIVE FOR ALL
      USING (false);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- cover_aliases (if exists): server-only; no direct client access.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'cover_aliases') THEN
    ALTER TABLE cover_aliases ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "cover_aliases_no_direct_access" ON cover_aliases;
    CREATE POLICY "cover_aliases_no_direct_access" ON cover_aliases
      AS RESTRICTIVE FOR ALL
      USING (false);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- user_stats (if exists): rls_policy_always_true (WARN, SECURITY) — never WITH CHECK (true).
-- Any INSERT policy with WITH CHECK (true) lets callers insert rows for other users.
-- Audit existing policies: select policyname, polcmd, polroles, polqual, polwithcheck
--   from pg_policies where schemaname='public' and tablename='user_stats';
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'user_stats') THEN
    ALTER TABLE user_stats ENABLE ROW LEVEL SECURITY;
    -- Drop every existing policy so no WITH CHECK (true) or broad role remains (names vary by linter/dashboard).
    FOR r IN (SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_stats')
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.user_stats', r.policyname);
    END LOOP;
    -- Single strict policy: authenticated can only read/insert/update/delete their own row. Initplan for perf.
    CREATE POLICY "user_stats_own_row_only" ON user_stats
      FOR ALL TO authenticated
      USING (user_id = (select auth.uid()))
      WITH CHECK (user_id = (select auth.uid()));
    -- anon: no access. Server writes (e.g. clear-library) use service role and bypass RLS.
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- public.users (if exists): user can read/update only their own row. (select auth.uid()) = initplan for perf.
-- Skip if table does not exist (e.g. you only use auth.users).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "users_select_own" ON users;
    CREATE POLICY "users_select_own" ON users
      FOR SELECT TO authenticated
      USING (id = (select auth.uid()));
    DROP POLICY IF EXISTS "users_update_own" ON users;
    CREATE POLICY "users_update_own" ON users
      FOR UPDATE TO authenticated
      USING (id = (select auth.uid()))
      WITH CHECK (id = (select auth.uid()));
  END IF;
END $$;
