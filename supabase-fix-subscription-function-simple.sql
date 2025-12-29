-- Simple fix - completely avoids any ambiguous references
-- Run this in your Supabase SQL Editor

DROP FUNCTION IF EXISTS public.get_user_scan_usage(UUID) CASCADE;

CREATE FUNCTION public.get_user_scan_usage(user_uuid UUID)
RETURNS TABLE(
  subscription_tier TEXT,
  monthly_scans INTEGER,
  monthly_limit INTEGER,
  scans_remaining INTEGER,
  reset_at TIMESTAMPTZ
) AS $$
DECLARE
  v_user_tier TEXT;
  v_monthly_count INTEGER;
  v_reset_at TIMESTAMPTZ;
  v_free_limit INTEGER := 5;
BEGIN
  -- Reset monthly scans if needed
  PERFORM public.reset_monthly_scans();
  
  -- Get user's subscription tier
  SELECT COALESCE(p.subscription_tier, 'free') INTO v_user_tier
  FROM public.profiles p
  WHERE p.id = user_uuid;
  
  -- Get monthly scan count
  SELECT COALESCE(us.monthly_scans, 0), COALESCE(us.monthly_reset_at, DATE_TRUNC('month', NOW()) + INTERVAL '1 month')
  INTO v_monthly_count, v_reset_at
  FROM public.user_stats us
  WHERE us.user_id = user_uuid;
  
  -- Return the result using explicit values (no table references)
  RETURN QUERY SELECT
    v_user_tier::TEXT,
    v_monthly_count,
    CASE WHEN v_user_tier = 'pro' THEN NULL::INTEGER ELSE v_free_limit END,
    CASE 
      WHEN v_user_tier = 'pro' THEN NULL::INTEGER
      ELSE GREATEST(0, v_free_limit - v_monthly_count)::INTEGER
    END,
    v_reset_at;
    
  -- If no row was returned (no stats record), return defaults
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      COALESCE(v_user_tier, 'free')::TEXT,
      0::INTEGER,
      v_free_limit::INTEGER,
      v_free_limit::INTEGER,
      (DATE_TRUNC('month', NOW()) + INTERVAL '1 month')::TIMESTAMPTZ;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.get_user_scan_usage(UUID) TO authenticated;


