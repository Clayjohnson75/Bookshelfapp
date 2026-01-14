# Create Account via Supabase Dashboard (No Email Confirmation)

## Easiest Method: Use Supabase Dashboard

### Step 1: Create User in Supabase Dashboard

1. Go to your Supabase project dashboard
2. Navigate to **Authentication** → **Users**
3. Click **Add User** (or **Invite User**)
4. Fill in:
   - **Email**: `user_95d737b1@test.com` (or any email - doesn't need to be real)
   - **Password**: `Review123!`
   - **Auto Confirm User**: ✅ **Check this box** (this bypasses email confirmation)
5. Click **Create User**

### Step 2: Set Username in Profile

After creating the user, you need to set the username:

1. Go to **Table Editor** → **profiles**
2. Find the user you just created (by email)
3. Edit the row and set:
   - **username**: `user_95d737b1`
   - **display_name**: `App Store Review` (optional)

### Step 3: Set Up Expired Subscription

Run this SQL in the SQL Editor:

```sql
UPDATE profiles
SET 
  subscription_tier = 'pro',
  subscription_status = 'active',  -- Must be 'active' due to check constraint, but ends_at in past makes it expired
  subscription_started_at = NOW() - INTERVAL '2 months',
  subscription_ends_at = NOW() - INTERVAL '1 month',
  updated_at = NOW()::text
WHERE username = 'user_95d737b1';
```

### Step 4: Verify

Run this to verify:

```sql
SELECT 
  u.email,
  p.username,
  p.subscription_tier,
  p.subscription_status,
  p.subscription_ends_at,
  CASE 
    WHEN p.subscription_ends_at::timestamp < NOW() THEN 'EXPIRED ✓'
    ELSE 'ACTIVE'
  END as status
FROM auth.users u
JOIN profiles p ON p.id = u.id
WHERE p.username = 'user_95d737b1';
```

## Alternative: Use Temporary Email

If you prefer to sign up through the app:

1. Go to https://temp-mail.org or https://10minutemail.com
2. Get a temporary email address
3. Sign up in the app with:
   - **Email**: (the temp email you got)
   - **Username**: `user_95d737b1`
   - **Password**: `Review123!`
4. Check the temp email for confirmation link (if needed)
5. Then run the SQL from Step 3 above to set up expired subscription

## Test the Account

1. Sign in to the app with:
   - **Username**: `user_95d737b1`
   - **Password**: `Review123!`
2. Try to use "Ask Your Library" feature
3. Should see: "This feature is available to Pro users only."
4. Should see upgrade prompts

## App Store Connect

Add these credentials to App Store Connect:
- **Username**: `appstorereview`
- **Password**: `Review123!`
- **Notes**: "Account has expired Pro subscription. Can test purchase flow."

