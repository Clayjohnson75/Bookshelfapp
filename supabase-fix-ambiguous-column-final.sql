-- ============================================================
-- BOOKSHELF SCANNER - Fix Ambiguous Column Reference
-- ============================================================
-- This fixes the "column reference subscription_tier is ambiguous" error
-- in the get_user_scan_usage function
-- ============================================================

-- Drop and recreate the function with explicit table aliases
DROP FUNCTION IF EXISTS public.get_user_scan_usage(UUID);

CREATE OR REPLACE FUNCTION public.get_user_scan_usage(user_uuid UUID)
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
  
  -- Get user's subscription tier from profiles table (explicit table alias)
  SELECT p.subscription_tier INTO v_user_tier
  FROM public.profiles p
  WHERE p.id = user_uuid;
  
  -- Get monthly scan count from user_stats table (explicit table alias)
  SELECT COALESCE(us.monthly_scans, 0), us.monthly_reset_at
  INTO v_monthly_count, v_reset_at
  FROM public.user_stats us
  WHERE us.user_id = user_uuid;
  
  -- Return usage info using declared variables (not selecting from tables)
  -- Owner and Pro users have unlimited scans (NULL limit)
  IF v_monthly_count IS NOT NULL THEN
    RETURN QUERY SELECT
      COALESCE(v_user_tier, 'free')::TEXT,
      v_monthly_count,
      CASE 
        WHEN COALESCE(v_user_tier, 'free') IN ('pro', 'owner') THEN NULL 
        ELSE v_free_limit 
      END,
      CASE 
        WHEN COALESCE(v_user_tier, 'free') IN ('pro', 'owner') THEN NULL 
        ELSE GREATEST(0, v_free_limit - v_monthly_count)
      END,
      COALESCE(v_reset_at, DATE_TRUNC('month', NOW()) + INTERVAL '1 month');
  ELSE
    -- If no stats record exists, return defaults
    RETURN QUERY SELECT
      COALESCE(v_user_tier, 'free')::TEXT,
      0,
      CASE 
        WHEN COALESCE(v_user_tier, 'free') IN ('pro', 'owner') THEN NULL 
        ELSE v_free_limit 
      END,
      CASE 
        WHEN COALESCE(v_user_tier, 'free') IN ('pro', 'owner') THEN NULL 
        ELSE v_free_limit 
      END,
      DATE_TRUNC('month', NOW()) + INTERVAL '1 month';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.get_user_scan_usage(UUID) TO authenticated;




