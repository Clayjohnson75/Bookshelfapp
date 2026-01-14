-- Create Expired Pro Account for App Store Review
-- Run this in BOTH dev AND production Supabase SQL editor

-- Step 1: Find the test account
SELECT id, username, subscription_tier, subscription_status, subscription_ends_at
FROM profiles 
WHERE username = 'user_95d737b1';

-- Step 2: Set up account with expired subscription (shows as FREE, not Pro)
-- For Apple review: Account should NOT have Pro access, so they can test the purchase flow
-- We set tier to 'free' so the account clearly shows as non-Pro
-- The subscription history shows it had Pro before (expired)
UPDATE profiles
SET 
  subscription_tier = 'free',  -- Set to 'free' so account shows as non-Pro (allows testing purchase flow)
  subscription_status = 'active',  -- Must be 'active' due to check constraint
  subscription_started_at = NOW() - INTERVAL '2 months',  -- Shows it had a subscription before
  subscription_ends_at = NOW() - INTERVAL '1 month',  -- Expired 1 month ago
  updated_at = NOW()
WHERE username = 'user_95d737b1';

-- Step 3: Verify the expired subscription setup
SELECT 
  id,
  username,
  subscription_tier,
  subscription_status,
  subscription_started_at,
  subscription_ends_at,
  CASE 
    WHEN subscription_ends_at::timestamp < NOW() THEN 'EXPIRED (date) ✓'
    WHEN subscription_status = 'active' AND subscription_ends_at::timestamp > NOW() THEN 'ACTIVE ✓'
    ELSE 'UNKNOWN'
  END as expiration_check,
  CASE
    WHEN subscription_tier IN ('pro', 'owner') 
         AND subscription_status = 'active' 
         AND (subscription_ends_at IS NULL OR subscription_ends_at::timestamp > NOW())
    THEN 'PRO ACCESS: YES'
    ELSE 'PRO ACCESS: NO (correct for expired)'
  END as pro_access_check
FROM profiles
WHERE username = 'user_95d737b1';

-- Expected result:
-- subscription_tier: 'free' (account shows as FREE, not Pro)
-- subscription_status: 'active' (required by check constraint)
-- subscription_ends_at: 1 month ago (shows expired subscription history)
-- expiration_check: 'EXPIRED (date) ✓'
-- pro_access_check: 'PRO ACCESS: NO (correct - account is free, can test purchase)'
--
-- This setup allows Apple to:
-- 1. Sign in and see the account is NOT Pro (tier='free')
-- 2. Test the purchase flow to upgrade to Pro
-- 3. See that the account previously had a subscription (expired)

