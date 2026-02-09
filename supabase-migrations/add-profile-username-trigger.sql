-- Migration: Add trigger to auto-fill username on profiles insert
-- Goal: Ensure username is always set, even if code forgets to provide it
-- Date: 2026-02-04
--
-- This trigger automatically sets a default username based on the profile id
-- Format: 'user_' + first 8 characters of id (with hyphens removed)
-- Example: 'user_a1b2c3d4' for id 'a1b2c3d4-5678-90ef-ghij-klmnopqrstuv'

-- Step 1: Create trigger function
CREATE OR REPLACE FUNCTION public.set_default_profile_username()
RETURNS trigger AS $$
BEGIN
  -- Only set username if it's NULL or empty string
  IF NEW.username IS NULL OR NEW.username = '' THEN
    -- Generate username from id: 'user_' + first 8 chars of id (without hyphens)
    NEW.username := 'user_' || substr(replace(NEW.id::text, '-', ''), 1, 8);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 2: Drop existing trigger if it exists (idempotent)
DROP TRIGGER IF EXISTS trg_set_default_profile_username ON public.profiles;That log means your mobile app is sending an Apple/Google ID token (JWT alg: ES256) to /api/scan, but the server expects a Supabase access_token (HS256 / signed by Supabase). So the server can’t getUser(token) and you fall into guest/anonymous scan behavior (or profile creation fails, batch queue breaks, etc.).

Fix = stop sending the provider ID token, send the Supabase session access token
What to tell Cursor to do (client + server)
1) Client: set Authorization header from supabase.auth.getSession()
Wherever you call /api/scan (and batch enqueue), change it to:

const { data: sessData, error: sessErr } = await supabase.auth.getSession();
const accessToken = sessData.session?.access_token;


-- Step 3: Create trigger that runs BEFORE INSERT and UPDATE
-- This ensures username is always set, even on updates
CREATE TRIGGER trg_set_default_profile_username
BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.set_default_profile_username();

-- Step 4: Add comment documenting the trigger
COMMENT ON FUNCTION public.set_default_profile_username() IS 
  'Trigger function to auto-generate username from profile id if username is not provided. Format: user_<first8charsOfId>';

-- Step 5: Verify the trigger was created
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 
    FROM pg_trigger 
    WHERE tgname = 'trg_set_default_profile_username' 
    AND tgrelid = 'public.profiles'::regclass
  ) THEN
    RAISE NOTICE '✅ Successfully created trigger: trg_set_default_profile_username';
  ELSE
    RAISE WARNING '⚠️ Trigger may not have been created correctly';
  END IF;
END $$;

