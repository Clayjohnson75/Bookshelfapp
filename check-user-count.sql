-- Query to check how many user accounts are in the system
-- Run this in your Supabase SQL Editor

-- Total number of user accounts
SELECT COUNT(*) as total_users FROM profiles;

-- Users with details
SELECT 
  id,
  username,
  email,
  subscription_tier,
  created_at
FROM profiles
ORDER BY created_at DESC;

-- Users by subscription tier
SELECT 
  subscription_tier,
  COUNT(*) as count
FROM profiles
GROUP BY subscription_tier;

-- Recent signups (last 30 days)
SELECT COUNT(*) as recent_signups
FROM profiles
WHERE created_at > NOW() - INTERVAL '30 days';





