# Test Pro Account System

## ✅ Setup Complete!

The pro account system is now fully integrated. Here's how to test it:

## Quick Test Steps

### 1. Test Free Account (5 Scans Limit)

1. **Sign in** with a test account
2. **Scan 5 times** - should work fine
3. **Try 6th scan** - should see:
   - Alert: "Scan Limit Reached"
   - Upgrade modal option
   - Scan should be blocked

### 2. Test Pro Account (Unlimited)

1. **Upgrade test account to Pro**:
   ```sql
   -- Run in Supabase SQL Editor
   UPDATE public.profiles
   SET 
     subscription_tier = 'pro',
     subscription_status = 'active',
     subscription_started_at = NOW(),
     subscription_ends_at = NULL,
     updated_at = NOW()
   WHERE id IN (
     SELECT id FROM auth.users WHERE email = 'YOUR_TEST_EMAIL@example.com'
   );
   ```

2. **Sign out and sign back in** (to refresh subscription status)
3. **Scan multiple times** - should work unlimited
4. **Check banner** - should not show scan limit

### 3. Verify Scan Tracking

Check scan counts in Supabase:
```sql
SELECT 
  u.email,
  us.monthly_scans,
  us.total_scans,
  us.monthly_reset_at,
  p.subscription_tier
FROM user_stats us
JOIN auth.users u ON us.user_id = u.id
LEFT JOIN profiles p ON p.id = u.id
WHERE u.email = 'YOUR_TEST_EMAIL@example.com';
```

## What to Look For

### ✅ Working Correctly:
- Scan limit banner shows remaining scans
- Banner updates after each scan
- 6th scan shows upgrade prompt
- Pro users see no limit banner
- Monthly scans increment correctly
- Server-side validation blocks scans at limit

### ⚠️ If Issues:
- Check Supabase migration ran successfully
- Verify user has profile record
- Check console for errors
- Verify `can_user_scan()` function exists

## Manual Reset (For Testing)

To reset monthly scans for testing:
```sql
UPDATE user_stats 
SET 
  monthly_scans = 0,
  monthly_reset_at = DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
WHERE user_id = 'USER_UUID_HERE';
```

## Current Status

- ✅ Database migration complete
- ✅ Scan limit checking (client + server)
- ✅ UI components integrated
- ✅ Monthly tracking working
- ✅ Pro account support
- ⏳ Apple IAP (coming later)

## Next Steps

1. **Test the system** with the steps above
2. **Verify** scan limits work correctly
3. **Test** pro account unlimited scans
4. **When ready**: Add Apple IAP integration

Everything is set up and ready to test! 🎉


