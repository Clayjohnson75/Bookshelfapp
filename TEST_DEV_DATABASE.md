# Testing Development Database Setup

## Step 1: Verify Tables Were Created

Run this in your **development Supabase SQL Editor**:

```sql
-- Check if all tables exist
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('profiles', 'books', 'photos', 'user_stats')
ORDER BY table_name;
```

**Expected Result**: Should return 4 rows (profiles, books, photos, user_stats)

## Step 2: Verify Functions Were Created

```sql
-- Check if subscription functions exist
SELECT routine_name 
FROM information_schema.routines 
WHERE routine_schema = 'public' 
  AND routine_name IN ('can_user_scan', 'get_user_scan_usage', 'increment_user_scan_count', 'reset_monthly_scans')
ORDER BY routine_name;
```

**Expected Result**: Should return 4 rows (all functions)

## Step 3: Verify Storage Bucket

1. Go to **Storage** → **Buckets**
2. Should see `photos` bucket
3. Make sure it's **Public**

## Step 4: Test App Connection to Dev Database

### 4.1 Update .env File

Make sure your `.env` file has:
```
EXPO_PUBLIC_SUPABASE_URL_DEV=https://gsfkjwmdwhptakgcbuxe.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY_DEV=sb_publishable_SQXyEXtJbal30DdcqzX8gQ_VPuxA_XH
```

### 4.2 Restart Expo Go

1. Stop Expo Go (Ctrl+C)
2. Start again: `npx expo start`
3. **Important**: Restart to load new environment variables

### 4.3 Check Console Logs

When the app starts, look for:
```
📋 Loaded env var: EXPO_PUBLIC_SUPABASE_URL_DEV
```

And when connecting:
```
📥 Loading user data from Supabase...
```

### 4.4 Verify Dev Database URL

Check the console - it should show your **dev** Supabase URL:
- ✅ `https://gsfkjwmdwhptakgcbuxe.supabase.co` (dev)
- ❌ NOT `https://cnlnrlzhhbrtehpkttqv.supabase.co` (production)

## Step 5: Test Sign In

1. **Sign in** with a test account (or create a new one)
2. **Check Supabase Dashboard**:
   - Go to https://gsfkjwmdwhptakgcbuxe.supabase.co
   - Go to **Authentication** → **Users**
   - Should see your new test user

## Step 6: Test Scanning

1. **Scan a book** in the app
2. **Check Dev Database**:
   - Go to **Table Editor** → **books**
   - Should see the book you just scanned
   - **Verify**: This should NOT appear in production database

3. **Check Dev Storage**:
   - Go to **Storage** → **photos** bucket
   - Should see the photo you uploaded

## Step 7: Verify Production is Separate

1. **Check Production Database**:
   - Go to https://cnlnrlzhhbrtehpkttqv.supabase.co
   - Go to **Table Editor** → **books**
   - **Verify**: Your test scan should NOT be here

2. **Check Production Storage**:
   - Go to **Storage** → **photos** bucket
   - **Verify**: Your test photo should NOT be here

## Step 8: Test Subscription Functions

Run this in **dev Supabase SQL Editor**:

```sql
-- Test can_user_scan function (will return true for new user)
-- Replace 'YOUR_USER_UUID' with a user ID from auth.users
SELECT can_user_scan('YOUR_USER_UUID');

-- Test get_user_scan_usage function
SELECT * FROM get_user_scan_usage('YOUR_USER_UUID');
```

**Expected Result**: 
- `can_user_scan` should return `true` (new user has 0 scans)
- `get_user_scan_usage` should return subscription tier, monthly scans, etc.

## Quick Verification Checklist

- [ ] All 4 tables exist (profiles, books, photos, user_stats)
- [ ] All 4 functions exist (can_user_scan, get_user_scan_usage, increment_user_scan_count, reset_monthly_scans)
- [ ] Photos bucket exists and is public
- [ ] App console shows dev Supabase URL
- [ ] Can sign in and create account
- [ ] Can scan a book
- [ ] Book appears in dev database
- [ ] Book does NOT appear in production database
- [ ] Photo appears in dev storage
- [ ] Photo does NOT appear in production storage

## Success Indicators

✅ **Working Correctly**:
- App connects to dev database
- Data saves to dev database
- Data does NOT appear in production
- Console shows dev Supabase URL

❌ **Not Working**:
- App connects to production database
- Data appears in both dev and production
- Console shows production Supabase URL
- Error messages about missing tables/functions

## Troubleshooting

### If app still uses production database:
1. Check `.env` file has `_DEV` values
2. Restart Expo Go completely
3. Clear Expo cache: `npx expo start -c`

### If tables don't exist:
1. Re-run `supabase-dev-database-complete-setup.sql`
2. Check for any error messages
3. Verify you're in the correct Supabase project (dev, not prod)

### If functions don't work:
1. Check function exists: `SELECT routine_name FROM information_schema.routines WHERE routine_name = 'can_user_scan';`
2. Re-run the function creation part of the setup script




