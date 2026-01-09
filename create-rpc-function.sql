-- Create RPC function to get email by username in dev Supabase
-- Run this in your dev Supabase SQL editor

CREATE OR REPLACE FUNCTION public.get_email_by_username(username_input TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
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
  SELECT email INTO user_email
  FROM auth.users
  WHERE id = user_id
  LIMIT 1;
  
  RETURN user_email;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION public.get_email_by_username(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_email_by_username(TEXT) TO anon;

