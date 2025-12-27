-- ============================================================
-- BOOKSHELF SCANNER - Subscriptions & Monthly Scan Tracking
-- ============================================================
-- Copy and paste this entire file into your Supabase SQL Editor
-- This creates the subscription system for pro accounts
-- ============================================================

-- Add subscription fields to profiles table
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro')),
  ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'active' CHECK (subscription_status IN ('active', 'cancelled', 'past_due', 'trialing')),
  ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

-- Create index for faster subscription queries
CREATE INDEX IF NOT EXISTS idx_profiles_subscription_tier ON public.profiles(subscription_tier);
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer_id ON public.profiles(stripe_customer_id);

-- Update user_stats to track monthly scans
ALTER TABLE public.user_stats
  ADD COLUMN IF NOT EXISTS monthly_scans INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS monthly_reset_at TIMESTAMPTZ DEFAULT (DATE_TRUNC('month', NOW()) + INTERVAL '1 month');

-- Create index for monthly scan queries
CREATE INDEX IF NOT EXISTS idx_user_stats_monthly_reset_at ON public.user_stats(monthly_reset_at);

-- Function to reset monthly scan count (runs automatically)
CREATE OR REPLACE FUNCTION public.reset_monthly_scans()
RETURNS void AS $$
BEGIN
  UPDATE public.user_stats
  SET 
    monthly_scans = 0,
    monthly_reset_at = DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
  WHERE monthly_reset_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to increment monthly scan count (updates increment_user_scan_count)
CREATE OR REPLACE FUNCTION public.increment_user_scan_count(user_uuid UUID)
RETURNS void AS $$
BEGIN
  -- Reset monthly scans if needed
  PERFORM public.reset_monthly_scans();
  
  INSERT INTO public.user_stats (user_id, total_scans, monthly_scans, last_scan_at, created_at, updated_at, monthly_reset_at)
  VALUES (user_uuid, 1, 1, NOW(), NOW(), NOW(), DATE_TRUNC('month', NOW()) + INTERVAL '1 month')
  ON CONFLICT (user_id) 
  DO UPDATE SET 
    total_scans = user_stats.total_scans + 1,
    monthly_scans = CASE 
      WHEN user_stats.monthly_reset_at < NOW() THEN 1
      ELSE user_stats.monthly_scans + 1
    END,
    monthly_reset_at = CASE
      WHEN user_stats.monthly_reset_at < NOW() THEN DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
      ELSE user_stats.monthly_reset_at
    END,
    last_scan_at = NOW(),
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if user can scan (returns true if can scan, false if limit reached)
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
  
  -- Pro users have unlimited scans
  IF user_tier = 'pro' THEN
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

-- Function to get user's scan usage info
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
  
  -- Return usage info
  RETURN QUERY SELECT
    COALESCE(user_tier, 'free')::TEXT,
    monthly_count,
    CASE WHEN user_tier = 'pro' THEN NULL ELSE free_limit END,
    CASE 
      WHEN user_tier = 'pro' THEN NULL 
      ELSE GREATEST(0, free_limit - monthly_count)
    END,
    COALESCE(reset_at, DATE_TRUNC('month', NOW()) + INTERVAL '1 month')
  FROM public.user_stats
  WHERE user_id = user_uuid
  LIMIT 1;
  
  -- If no stats record exists, return defaults
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      COALESCE(user_tier, 'free')::TEXT,
      0,
      free_limit,
      free_limit,
      DATE_TRUNC('month', NOW()) + INTERVAL '1 month';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.can_user_scan(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_scan_usage(UUID) TO authenticated;

-- Add comments
COMMENT ON COLUMN public.profiles.subscription_tier IS 'User subscription tier: free or pro';
COMMENT ON COLUMN public.profiles.subscription_status IS 'Subscription status: active, cancelled, past_due, trialing';
COMMENT ON COLUMN public.profiles.stripe_customer_id IS 'Stripe customer ID for payment processing';
COMMENT ON COLUMN public.profiles.stripe_subscription_id IS 'Stripe subscription ID';
COMMENT ON COLUMN public.user_stats.monthly_scans IS 'Number of scans this month (resets monthly)';
COMMENT ON COLUMN public.user_stats.monthly_reset_at IS 'Timestamp when monthly scans reset';

