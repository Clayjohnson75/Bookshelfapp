-- Create RPC function to get email by username
-- Run this in BOTH dev AND production Supabase SQL editor

CREATE OR REPLACE FUNCTION public.get_email_by_username(username_input TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  user_email TEXT;
  user_id UUID;
BEGIN
  -- Get user ID from profiles table
  SELECT id INTO user_id
  FROM public.profiles
  WHERE username = LOWER(username_input)
  LIMIT 1;
  
  -- If user not found, return NULL
  IF user_id IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Get email from auth.users (requires service role or admin)
  -- Note: This function must be SECURITY DEFINER to access auth.users
  -- SET search_path ensures we can access auth schema
  SELECT email INTO user_email
  FROM auth.users
  WHERE id = user_id
  LIMIT 1;
  
  RETURN user_email;
END;
$$;

-- Grant execute permission to authenticated and anon users
GRANT EXECUTE ON FUNCTION public.get_email_by_username(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_email_by_username(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.get_email_by_username(TEXT) TO service_role;

-- Verify the function was created
SELECT proname, proargnames, prosrc 
FROM pg_proc 
WHERE proname = 'get_email_by_username';

