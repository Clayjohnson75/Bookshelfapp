-- ============================================================
-- BOOKSHELF SCANNER - Set Owner Account for "clay"
-- ============================================================
-- This script sets the user with username "clay" to owner tier
-- Owner accounts get all pro features plus additional features
-- ============================================================

-- Update the user with username "clay" to owner tier
UPDATE public.profiles
SET 
  subscription_tier = 'owner',
  subscription_status = 'active',
  subscription_started_at = NOW(),
  updated_at = NOW()
WHERE username = 'clay';

-- Verify the update
SELECT 
  id,
  username,
  subscription_tier,
  subscription_status,
  subscription_started_at
FROM public.profiles
WHERE username = 'clay';





