-- Fix for ambiguous column reference in get_user_scan_usage function
-- Run this in your Supabase SQL Editor to fix the error

CREATE OR REPLACE FUNCTION public.get_user_scan_usage(user_uuid UUID)
RETURNS TABLE(
  subscription_tier TEXT,
  monthly_scans INTEGER,
  monthly_limit INTEGER,
  scans_remaining INTEGER,
  reset_at TIMESTAMPTZ
) AS $$
DECLARE
  user_tier TEXT;
  monthly_count INTEGER;
  reset_at TIMESTAMPTZ;
  free_limit INTEGER := 5;
BEGIN
  -- Reset monthly scans if needed
  PERFORM public.reset_monthly_scans();
  
  -- Get user's subscription tier
  SELECT subscription_tier INTO user_tier
  FROM public.profiles
  WHERE id = user_uuid;
  
  -- Get monthly scan count
  SELECT COALESCE(monthly_scans, 0), monthly_reset_at
  INTO monthly_count, reset_at
  FROM public.user_stats
  WHERE user_id = user_uuid;
  
  -- Return usage info using variables (not selecting from tables)
  -- This avoids ambiguous column references
  IF monthly_count IS NOT NULL THEN
    RETURN QUERY SELECT
      COALESCE(user_tier, 'free')::TEXT,
      monthly_count,
      CASE WHEN COALESCE(user_tier, 'free') = 'pro' THEN NULL ELSE free_limit END,
      CASE 
        WHEN COALESCE(user_tier, 'free') = 'pro' THEN NULL 
        ELSE GREATEST(0, free_limit - monthly_count)
      END,
      COALESCE(reset_at, DATE_TRUNC('month', NOW()) + INTERVAL '1 month');
  ELSE
    -- If no stats record exists, return defaults
    RETURN QUERY SELECT
      COALESCE(user_tier, 'free')::TEXT,
      0,
      free_limit,
      free_limit,
      DATE_TRUNC('month', NOW()) + INTERVAL '1 month';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions (in case it was dropped)
GRANT EXECUTE ON FUNCTION public.get_user_scan_usage(UUID) TO authenticated;




