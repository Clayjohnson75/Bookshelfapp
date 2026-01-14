# Apple App Store Review - Demo Account Setup

## Apple's Request

Apple needs a demo account with an **expired subscription** to test the purchase flow. The account should:
- ✅ **NOT** show as Pro (so they can test upgrading)
- ✅ Have subscription history showing it expired
- ✅ Allow testing the full purchase flow

## SQL Setup

Run this SQL in **PRODUCTION Supabase** (where Apple will test):

```sql
-- Set up demo account for Apple review
UPDATE profiles
SET 
  subscription_tier = 'free',  -- Account shows as FREE (not Pro)
  subscription_status = 'active',  -- Required by check constraint
  subscription_started_at = NOW() - INTERVAL '2 months',  -- Had subscription before
  subscription_ends_at = NOW() - INTERVAL '1 month',  -- Expired 1 month ago
  updated_at = NOW()
WHERE username = 'user_95d737b1';

-- Verify the setup
SELECT 
  username,
  subscription_tier,
  subscription_status,
  subscription_ends_at,
  CASE 
    WHEN subscription_tier = 'free' THEN 'FREE (correct for testing) ✓'
    ELSE 'PRO (wrong - should be free)'
  END as account_status
FROM profiles
WHERE username = 'user_95d737b1';
```

## Expected Result

- `subscription_tier`: `'free'` ✅ (account shows as FREE)
- `subscription_status`: `'active'` (required by constraint)
- `subscription_ends_at`: 1 month ago (shows expired history)
- Account should **NOT** have Pro access
- Account should show upgrade prompts

## App Store Connect Setup

1. Go to **App Store Connect** → Your App → **App Information**
2. Scroll to **App Review Information**
3. Fill in:
   - **Username**: `user_95d737b1`
   - **Password**: (the password for this account)
   - **Notes**: "This account has an expired subscription. You can test the purchase flow by upgrading to Pro. The account currently shows as Free tier."

## Testing Checklist

Before submitting, verify:
- [ ] Account shows as **FREE** (not Pro) in the app
- [ ] "Upgrade to Pro" button is visible
- [ ] Purchase flow works (test with sandbox account)
- [ ] After purchase, account becomes Pro
- [ ] SQL run in **PRODUCTION** Supabase
- [ ] Credentials added to App Store Connect

## Why This Setup Works

1. **`subscription_tier = 'free'`**: Account clearly shows as non-Pro, allowing Apple to test the purchase flow
2. **`subscription_ends_at` in past**: Shows the account had a subscription that expired (meets Apple's requirement)
3. **Pro checks will fail**: All Pro feature checks will correctly return `false` because tier is 'free'
4. **Purchase flow testable**: Apple can sign in, see Free account, and test upgrading to Pro

## Important Notes

- ⚠️ Run this SQL in **PRODUCTION** Supabase (not dev)
- ⚠️ Make sure the account password is correct in App Store Connect
- ⚠️ Test the purchase flow yourself before submitting
- ⚠️ Use a sandbox tester account to verify purchase works

