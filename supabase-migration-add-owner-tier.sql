-- ============================================================
-- BOOKSHELF SCANNER - Add Owner Tier Support
-- ============================================================
-- This migration adds support for an "owner" tier above "pro"
-- Owner accounts get all pro features plus additional features
-- ============================================================

-- Update subscription_tier constraint to include 'owner'
ALTER TABLE public.profiles 
  DROP CONSTRAINT IF EXISTS profiles_subscription_tier_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_subscription_tier_check 
  CHECK (subscription_tier IN ('free', 'pro', 'owner'));

-- Update can_user_scan function to allow owner accounts unlimited scans
CREATE OR REPLACE FUNCTION public.can_user_scan(user_uuid UUID)
RETURNS BOOLEAN AS $$
DECLARE
  user_tier TEXT;
  monthly_count INTEGER;
  free_limit INTEGER := 5;
BEGIN
  -- Get user's subscription tier
  SELECT subscription_tier INTO user_tier
  FROM public.profiles
  WHERE id = user_uuid;
  
  -- Pro and Owner users have unlimited scans
  IF user_tier = 'pro' OR user_tier = 'owner' THEN
    RETURN TRUE;
  END IF;
  
  -- Reset monthly scans if needed
  PERFORM public.reset_monthly_scans();
  
  -- Get current monthly scan count
  SELECT COALESCE(monthly_scans, 0) INTO monthly_count
  FROM public.user_stats
  WHERE user_id = user_uuid;
  
  -- Check if under free limit
  RETURN monthly_count < free_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update get_user_scan_usage function to handle owner accounts
-- Use explicit table aliases and variable prefixes to avoid ambiguous column references
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

-- Update comment
COMMENT ON COLUMN public.profiles.subscription_tier IS 'User subscription tier: free, pro, or owner';

