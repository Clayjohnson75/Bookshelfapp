-- ============================================================
-- Create Test Account for Development
-- ============================================================
-- Run this in your DEV Supabase SQL Editor
-- This creates a test user you can use for development
-- ============================================================

-- Option 1: Create via Supabase Dashboard (Recommended)
-- 1. Go to https://gsfkjwmdwhptakgcbuxe.supabase.co
-- 2. Go to Authentication → Users → Add User
-- 3. Enter:
--    - Email: test@bookshelf.dev
--    - Password: TestPassword123!
--    - Auto Confirm User: Yes
-- 4. Click "Create User"

-- Option 2: Create via SQL (if you have service role key)
-- Note: This requires service role key, usually done via API or dashboard

-- After creating the user, you can sign in with:
-- Email: test@bookshelf.dev
-- Password: TestPassword123!

-- ============================================================
-- Alternative: Create Multiple Test Accounts
-- ============================================================

-- Test Account 1: Free tier user (5 scans/month)
-- Email: test-free@bookshelf.dev
-- Password: TestPassword123!

-- Test Account 2: Pro tier user (unlimited scans)
-- Email: test-pro@bookshelf.dev
-- Password: TestPassword123!
-- Then run this to upgrade to pro:
-- UPDATE public.profiles 
-- SET subscription_tier = 'pro', subscription_status = 'active'
-- WHERE id = (SELECT id FROM auth.users WHERE email = 'test-pro@bookshelf.dev');

-- Test Account 3: Owner tier user (unlimited scans)
-- Email: test-owner@bookshelf.dev
-- Password: TestPassword123!
-- Then run this to upgrade to owner:
-- UPDATE public.profiles 
-- SET subscription_tier = 'owner', subscription_status = 'active'
-- WHERE id = (SELECT id FROM auth.users WHERE email = 'test-owner@bookshelf.dev');

-- ============================================================
-- Quick Test Account Setup
-- ============================================================

-- Recommended test account:
-- Email: dev-test@bookshelf.dev
-- Password: DevTest123!

-- This account will:
-- - Start with 5 free scans per month
-- - Have an empty library
-- - Be separate from your production account
-- - Allow you to test scan limits, subscriptions, etc.





