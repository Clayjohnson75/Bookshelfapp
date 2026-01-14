# App Store Review Setup - Demo Account with Expired Subscription

## What Apple Needs

Apple needs credentials for a **real account** (not the local demo) with an **expired subscription** so they can test:
1. The purchase/upgrade flow
2. Subscription renewal
3. Expired subscription handling

## Steps to Create Demo Account

### 1. Create a Real Account in Your App

1. **Sign up a new account** using the app
   - Use a test email like: `appstore.review+expired@yourdomain.com`
   - Choose a username: `appstorereview`
   - Set a password: `Review123!` (or similar)

### 2. Create the Account in Supabase

You can either:
- **Option A**: Sign up through the app (recommended)
- **Option B**: Create manually in Supabase (if you have admin access)

### 3. Set Up Expired Subscription in Supabase

Run this SQL in your Supabase SQL Editor:

```sql
-- Find the user by username/email
SELECT id, username, email 
FROM profiles 
WHERE username = 'appstorereview' OR email = 'appstore.review+expired@yourdomain.com';

-- Then update their subscription to expired (replace USER_ID with the actual ID from above)
UPDATE profiles
SET 
  subscription_tier = 'pro',
  subscription_status = 'expired',
  subscription_started_at = NOW() - INTERVAL '2 months',
  subscription_ends_at = NOW() - INTERVAL '1 month',  -- Expired 1 month ago
  updated_at = NOW()
WHERE id = 'USER_ID_FROM_ABOVE';
```

### 4. Provide Credentials in App Store Connect

1. Go to **App Store Connect** → Your App → **App Information**
2. Scroll to **App Review Information**
3. Fill in:
   - **Username**: `appstorereview` (or the username you chose)
   - **Password**: `Review123!` (or the password you set)
   - **Notes**: "This account has an expired Pro subscription. You can test the purchase flow by upgrading to Pro."

### 5. Test the Purchase Flow Yourself

Before submitting, make sure:
1. ✅ Sign in works with the demo account
2. ✅ You can see the "Upgrade to Pro" button
3. ✅ The purchase flow works (use sandbox account)
4. ✅ After purchase, subscription status updates correctly

## Testing Purchase Flow

### Using Sandbox Account

1. Sign out of your real Apple ID in Settings → App Store
2. In the app, try to purchase Pro
3. You'll be prompted to sign in with a sandbox account
4. Use a sandbox tester account from App Store Connect → Users and Access → Sandbox Testers

### Verify Purchase Works

After purchase:
- Check Supabase: `subscription_tier` should be `'pro'`
- Check `subscription_status` should be `'active'`
- Check `subscription_ends_at` should be ~1 month from now
- App should show "Pro" status

## Important Notes

- ⚠️ **Use a real account** (not the local demo account)
- ⚠️ **Subscription must be expired** (ends_at in the past)
- ⚠️ **Account must exist in Supabase** (real user, not local-only)
- ⚠️ **Test the purchase flow** before submitting

## Quick SQL to Create/Update Demo Account

```sql
-- First, find or note the user ID after they sign up
-- Then run this (replace USER_ID):

UPDATE profiles
SET 
  subscription_tier = 'pro',
  subscription_status = 'expired',
  subscription_started_at = (NOW() - INTERVAL '2 months')::text,
  subscription_ends_at = (NOW() - INTERVAL '1 month')::text,
  updated_at = NOW()::text
WHERE id = 'USER_ID_HERE';

-- Verify it's expired:
SELECT 
  username,
  email,
  subscription_tier,
  subscription_status,
  subscription_ends_at,
  CASE 
    WHEN subscription_ends_at::timestamp < NOW() THEN 'EXPIRED ✓'
    ELSE 'ACTIVE'
  END as status_check
FROM profiles
WHERE username = 'appstorereview';
```

