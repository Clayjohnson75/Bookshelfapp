-- ============================================================
-- USER STATS VIEW WITH USERNAMES
-- ============================================================
-- This creates a view that shows user_stats with usernames
-- Makes it easy to see stats for each user by username
-- ============================================================

-- Create a view that joins user_stats with profiles to show usernames
CREATE OR REPLACE VIEW public.user_stats_with_usernames AS
SELECT 
  us.id,
  us.user_id,
  p.username,
  p.display_name,
  p.subscription_tier,
  us.total_scans,
  us.monthly_scans,
  us.last_scan_at,
  us.monthly_reset_at,
  us.created_at,
  us.updated_at
FROM public.user_stats us
LEFT JOIN public.profiles p ON us.user_id = p.id
ORDER BY us.total_scans DESC;

-- Grant access to the view
GRANT SELECT ON public.user_stats_with_usernames TO authenticated;
GRANT SELECT ON public.user_stats_with_usernames TO anon;

-- ============================================================
-- USAGE:
-- ============================================================
-- To see all user stats with usernames:
--   SELECT * FROM user_stats_with_usernames;
--
-- To see stats for a specific username:
--   SELECT * FROM user_stats_with_usernames WHERE username = 'clay';
--
-- To see top scanners:
--   SELECT * FROM user_stats_with_usernames ORDER BY total_scans DESC LIMIT 10;
-- ============================================================

