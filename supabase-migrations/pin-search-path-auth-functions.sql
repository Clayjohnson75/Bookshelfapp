-- =============================================================================
-- function_search_path_mutable (WARN): Pin search_path on auth/advisor-flagged
-- functions that may exist in public schema (Supabase Dashboard / Auth triggers).
-- Run after pin-function-search-path.sql. Safe if functions do not exist.
-- =============================================================================

-- handle_new_user() — common trigger on auth.users; SECURITY DEFINER risk if path mutable
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'handle_new_user'
  ) THEN
    EXECUTE 'ALTER FUNCTION public.handle_new_user() SET search_path = pg_catalog, public';
  END IF;
END $$;

-- set_username(...) — if you have a function that sets profile username from auth
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'set_username'
  LOOP
    EXECUTE format('ALTER FUNCTION public.set_username(%s) SET search_path = pg_catalog, public', r.args);
  END LOOP;
END $$;

-- Add more ALTER FUNCTION blocks here for any other function the Database Advisor
-- flags for function_search_path_mutable. Pattern:
--   ALTER FUNCTION public.function_name(arg types) SET search_path = pg_catalog, public;
