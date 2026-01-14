-- Create Expired Pro Account Directly in Supabase (No Email Confirmation Needed)
-- Run this in BOTH dev AND production Supabase SQL editor
-- NOTE: This requires service role permissions or admin access

-- ============================================================================
-- OPTION 1: Create User via Supabase Admin API (Recommended)
-- ============================================================================
-- Use this approach if you have access to Supabase Dashboard or can use the Admin API
-- The user will be created with email confirmation already handled

-- Step 1: Create the auth user using Supabase Dashboard or Admin API
-- Go to: Authentication → Users → Add User
-- Email: appstorereview@test.com (or any email - won't need to confirm)
-- Password: Review123!
-- Auto Confirm User: ✅ (check this box)
-- Then run the UPDATE queries below

-- ============================================================================
-- OPTION 2: Create User Directly in SQL (Advanced - Requires Service Role)
-- ============================================================================
-- WARNING: This requires service role access and proper password hashing
-- Only use if you have admin/service role permissions

-- First, check if user already exists
DO $$
DECLARE
  user_id UUID;
  user_email TEXT := 'user_95d737b1@test.com';
  user_password TEXT := 'Review123!';
  hashed_password TEXT;
BEGIN
  -- Check if user already exists
  SELECT id INTO user_id
  FROM auth.users
  WHERE email = user_email;
  
  IF user_id IS NULL THEN
    -- Generate a UUID for the new user
    user_id := gen_random_uuid();
    
    -- Hash the password (using bcrypt - Supabase default)
    -- Note: In production, you'd use Supabase's auth.admin.createUser() API
    -- For SQL, we'll create the user with a pre-hashed password
    -- This is a placeholder - you'll need to hash it properly or use Admin API
    
    RAISE NOTICE 'User does not exist. Please create user via Supabase Dashboard or Admin API first.';
    RAISE NOTICE 'Then run the UPDATE queries below to set up the profile and subscription.';
  ELSE
    RAISE NOTICE 'User already exists with ID: %', user_id;
  END IF;
END $$;

-- ============================================================================
-- OPTION 3: Use Temporary Email Service (Easiest)
-- ============================================================================
-- 1. Go to https://temp-mail.org or https://10minutemail.com
-- 2. Get a temporary email address
-- 3. Sign up in the app with that email
-- 4. Check the temp email for confirmation (if needed)
-- 5. Then run the UPDATE queries below

-- ============================================================================
-- SET UP PROFILE AND EXPIRED SUBSCRIPTION
-- ============================================================================
-- After the user is created (via any method above), run these:

-- Step 1: Find the user ID (if you don't know it)
SELECT 
  u.id as user_id,
  u.email,
  u.email_confirmed_at,
  p.username,
  p.subscription_tier,
  p.subscription_status
FROM auth.users u
LEFT JOIN profiles p ON p.id = u.id
WHERE u.email LIKE '%user_95d737b1%' 
   OR p.username = 'user_95d737b1';

-- Step 2: Create/Update profile with username (if profile doesn't exist)
-- Replace USER_ID_HERE with the actual user ID from Step 1
INSERT INTO profiles (id, username, display_name, subscription_tier, subscription_status, subscription_started_at, subscription_ends_at, updated_at)
VALUES (
  'USER_ID_HERE',  -- Replace with actual user ID
  'user_95d737b1',
  'App Store Review',
  'pro',
  'active',  -- Must be 'active' due to check constraint, but ends_at in past makes it expired
  NOW() - INTERVAL '2 months',
  NOW() - INTERVAL '1 month',
  NOW()
)
ON CONFLICT (id) DO UPDATE
SET 
  username = 'user_95d737b1',
  subscription_tier = 'pro',
  subscription_status = 'active',  -- Must be 'active' due to check constraint, but ends_at in past makes it expired
  subscription_started_at = NOW() - INTERVAL '2 months',
  subscription_ends_at = NOW() - INTERVAL '1 month',
  updated_at = NOW();

-- Step 3: If you know the username but not the user ID, use this:
UPDATE profiles
SET 
  subscription_tier = 'pro',
  subscription_status = 'active',  -- Must be 'active' due to check constraint, but ends_at in past makes it expired
  subscription_started_at = NOW() - INTERVAL '2 months',
  subscription_ends_at = NOW() - INTERVAL '1 month',
  updated_at = NOW()
WHERE username = 'user_95d737b1';

-- Step 4: Verify the setup
SELECT 
  u.id,
  u.email,
  u.email_confirmed_at,
  p.username,
  p.display_name,
  p.subscription_tier,
  p.subscription_status,
  p.subscription_started_at,
  p.subscription_ends_at,
  CASE 
    WHEN p.subscription_ends_at::timestamp < NOW() THEN 'EXPIRED (date) ✓'
    ELSE 'ACTIVE'
  END as expiration_check,
  CASE
    WHEN p.subscription_tier IN ('pro', 'owner') 
         AND p.subscription_status = 'active' 
         AND (p.subscription_ends_at IS NULL OR p.subscription_ends_at::timestamp > NOW())
    THEN 'PRO ACCESS: YES'
    ELSE 'PRO ACCESS: NO (correct for expired)'
  END as pro_access_check
FROM auth.users u
LEFT JOIN profiles p ON p.id = u.id
WHERE u.email LIKE '%user_95d737b1%' 
   OR p.username = 'user_95d737b1';

-- Expected result:
-- email: 'appstorereview@test.com'
-- username: 'appstorereview'
-- subscription_tier: 'pro'
-- subscription_status: 'expired'
-- subscription_ends_at: 1 month ago
-- expiration_check: 'EXPIRED (status) ✓'
-- pro_access_check: 'PRO ACCESS: NO (correct for expired)'

