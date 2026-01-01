-- ============================================================
-- Migration: Stripe to Apple IAP
-- ============================================================
-- If you already ran the subscription migration with Stripe fields,
-- run this to migrate to Apple IAP fields instead
-- ============================================================

-- Remove Stripe columns (if they exist)
ALTER TABLE public.profiles 
  DROP COLUMN IF EXISTS stripe_customer_id,
  DROP COLUMN IF EXISTS stripe_subscription_id;

-- Drop Stripe index (if it exists)
DROP INDEX IF EXISTS idx_profiles_stripe_customer_id;

-- Add Apple IAP columns (if they don't exist)
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS apple_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS apple_original_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS apple_product_id TEXT;

-- Create index for Apple transaction ID
CREATE INDEX IF NOT EXISTS idx_profiles_apple_transaction_id ON public.profiles(apple_transaction_id);

-- Update comments
COMMENT ON COLUMN public.profiles.apple_transaction_id IS 'Apple IAP transaction ID for the current subscription';
COMMENT ON COLUMN public.profiles.apple_original_transaction_id IS 'Apple IAP original transaction ID (persists across renewals)';
COMMENT ON COLUMN public.profiles.apple_product_id IS 'Apple IAP product ID (e.g., com.bookshelfscanner.pro.monthly)';




