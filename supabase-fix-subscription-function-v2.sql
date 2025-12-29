-- Alternative fix using RETURN NEXT instead of RETURN QUERY
-- This completely avoids any table references in the return statement
-- Run this in your Supabase SQL Editor

DROP FUNCTION IF EXISTS public.get_user_scan_usage(UUID);

CREATE FUNCTION public.get_user_scan_usage(user_uuid UUID)
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
  reset_at_val TIMESTAMPTZ;
  free_limit INTEGER := 5;
  result_tier TEXT;
  result_scans INTEGER;
  result_limit INTEGER;
  result_remaining INTEGER;
  result_reset TIMESTAMPTZ;
BEGIN
  -- Reset monthly scans if needed
  PERFORM public.reset_monthly_scans();
  
  -- Get user's subscription tier
  SELECT COALESCE(subscription_tier, 'free') INTO user_tier
  FROM public.profiles
  WHERE id = user_uuid;
  
  -- Get monthly scan count
  SELECT COALESCE(monthly_scans, 0), COALESCE(monthly_reset_at, DATE_TRUNC('month', NOW()) + INTERVAL '1 month')
  INTO monthly_count, reset_at_val
  FROM public.user_stats
  WHERE user_id = user_uuid;
  
  -- Calculate values
  result_tier := COALESCE(user_tier, 'free');
  result_scans := COALESCE(monthly_count, 0);
  
  IF result_tier = 'pro' THEN
    result_limit := NULL;
    result_remaining := NULL;
  ELSE
    result_limit := free_limit;
    result_remaining := GREATEST(0, free_limit - result_scans);
  END IF;
  
  result_reset := COALESCE(reset_at_val, DATE_TRUNC('month', NOW()) + INTERVAL '1 month');
  
  -- Set the return values and return the row
  subscription_tier := result_tier;
  monthly_scans := result_scans;
  monthly_limit := result_limit;
  scans_remaining := result_remaining;
  reset_at := result_reset;
  
  RETURN NEXT;
  
  -- If no stats record was found, return defaults (but we already handled that above)
  -- This is just a safety check
  IF monthly_count IS NULL AND result_scans = 0 THEN
    -- Already returned defaults above, so we're done
    RETURN;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.get_user_scan_usage(UUID) TO authenticated;

