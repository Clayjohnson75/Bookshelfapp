-- ============================================================
-- Manual Upgrade to Pro (For Testing)
-- ============================================================
-- Use this to manually upgrade a user to Pro for testing
-- Replace 'USER_EMAIL_HERE' with the user's email
-- ============================================================

-- Upgrade user to Pro by email
UPDATE public.profiles
SET 
  subscription_tier = 'pro',
  subscription_status = 'active',
  subscription_started_at = NOW(),
  subscription_ends_at = NULL, -- NULL means active (no expiration for testing)
  updated_at = NOW()
WHERE id IN (
  SELECT id FROM auth.users WHERE email = 'USER_EMAIL_HERE'
);

-- Verify the update
SELECT 
  p.id,
  u.email,
  p.subscription_tier,
  p.subscription_status,
  p.subscription_started_at
FROM public.profiles p
JOIN auth.users u ON p.id = u.id
WHERE u.email = 'USER_EMAIL_HERE';

-- ============================================================
-- To downgrade back to free:
-- ============================================================
-- UPDATE public.profiles
-- SET 
--   subscription_tier = 'free',
--   subscription_status = 'active',
--   subscription_ends_at = NULL,
--   updated_at = NOW()
-- WHERE id IN (
--   SELECT id FROM auth.users WHERE email = 'USER_EMAIL_HERE'
-- );




