# Expired Pro Account Setup Guide

## Overview

This guide helps you create a test account with an **expired Pro subscription** for App Store review and testing Pro feature gating.

## Pro Feature Checks

The app checks Pro status in these places:

1. **`/api/library/ask`** - "Ask Your Library" feature
   - Uses `requirePro()` function
   - Checks: `subscription_tier` = 'pro'/'owner' AND `subscription_status` = 'active' AND `subscription_ends_at` > now

2. **`/api/check-subscription`** - Subscription status endpoint
   - Same logic as above

3. **Client-side checks** - Various UI components
   - Uses `checkSubscriptionStatus()` from `subscriptionService.ts`
   - Checks Supabase `profiles` table

## How Expired Subscriptions Are Rejected

An expired subscription will be **correctly rejected** if:
- `subscription_status` = 'expired' (fails the `=== 'active'` check), OR
- `subscription_ends_at` is in the past (fails the `> new Date()` check)

## Steps to Create Expired Pro Account

### Step 1: Sign Up Account in App

1. Open the app
2. Sign up with:
   - **Username**: `user_95d737b1`
   - **Email**: `appstore.review+expired@yourdomain.com` (or any test email)
   - **Password**: `Review123!` (or any password you'll remember)

### Step 2: Run SQL in Supabase

Run the SQL from `create-expired-pro-account.sql` in **BOTH**:
- Dev Supabase (for testing)
- Production Supabase (for App Store review)

The SQL will:
1. Find the account by username/email
2. Set `subscription_tier` = 'pro'
3. Set `subscription_status` = 'expired'
4. Set `subscription_ends_at` = 1 month ago
5. Verify the setup

### Step 3: Verify Pro Features Are Blocked

Test that expired account **cannot** access:
- ✅ "Ask Your Library" feature (should show "Pro subscription required")
- ✅ Any other Pro-only features

### Step 4: Test Purchase Flow

1. Sign in with the expired account
2. Try to use a Pro feature
3. Should see upgrade prompt
4. Test purchase flow (use sandbox account)
5. After purchase, subscription should become active

## SQL Script Location

See `create-expired-pro-account.sql` for the complete SQL script.

## App Store Connect Setup

1. Go to **App Store Connect** → Your App → **App Information**
2. Scroll to **App Review Information**
3. Fill in:
   - **Username**: `user_95d737b1`
   - **Password**: `Review123!` (or the password you set)
   - **Notes**: "This account has an expired Pro subscription. You can test the purchase flow by upgrading to Pro."

## Verification Queries

After running the SQL, verify with:

```sql
SELECT 
  username,
  email,
  subscription_tier,
  subscription_status,
  subscription_ends_at,
  CASE 
    WHEN subscription_status = 'expired' THEN 'EXPIRED ✓'
    WHEN subscription_ends_at::timestamp < NOW() THEN 'EXPIRED (date) ✓'
    ELSE 'ACTIVE'
  END as expiration_check
FROM profiles
WHERE username = 'user_95d737b1';
```

Expected result:
- `subscription_tier`: `'pro'`
- `subscription_status`: `'expired'`
- `subscription_ends_at`: 1 month ago
- `expiration_check`: `'EXPIRED ✓'`

## Testing Checklist

- [ ] Account created in app
- [ ] SQL run in dev Supabase
- [ ] SQL run in production Supabase
- [ ] Expired account cannot access "Ask Your Library"
- [ ] Expired account sees upgrade prompts
- [ ] Purchase flow works (sandbox)
- [ ] After purchase, subscription becomes active
- [ ] Credentials added to App Store Connect

