# App Review Notes - Pro Subscription

## Subscription Overview

**Pro Monthly Subscription** (`com.clayjohnson75.bookshelfscanner.pro.monthly`) provides users with unlimited book scans per month and access to all premium features.

## What the Pro Tier Provides

### Free Tier (Default):
- **5 book scans per month**
- Monthly scan limit resets on the 1st of each month
- Access to basic scanning features
- When limit is reached, users see an upgrade prompt and cannot scan until they upgrade or wait for monthly reset

### Pro Tier (Subscription):
- **Unlimited book scans per month** (no monthly limit)
- All premium features unlocked
- Priority support access
- Future premium features as they're released

## How to Test the Subscription

### Testing Free Tier (5 Scan Limit):
1. Sign in with a test account (or create a new account)
2. Navigate to the "Scans" tab
3. Take or upload photos of bookshelves to scan
4. After 5 scans, the app will:
   - Display an upgrade modal when attempting to scan
   - Show "Scan Limit Reached" message
   - Disable "Take Photo" and "Upload Image" buttons
   - Display remaining scans count (0/5)

### Testing Pro Tier (Unlimited Scans):
1. Purchase the Pro Monthly subscription through the in-app purchase flow
2. After successful purchase:
   - Subscription status updates to "Pro"
   - Scan limit banner disappears
   - User can scan unlimited times
   - No upgrade prompts appear

### Testing Subscription Purchase Flow:
1. When a free user reaches their 5-scan limit, tap "Take Photo" or "Upload Image"
2. Upgrade modal appears with subscription details
3. Tap "Upgrade to Pro" button
4. Apple's purchase dialog appears
5. Complete purchase with sandbox test account
6. Subscription activates immediately
7. User can now scan unlimited times

## Key Features to Verify

1. **Scan Limit Enforcement**: Free users cannot scan after 5 scans/month
2. **Upgrade Prompt**: Appears when limit is reached
3. **Subscription Purchase**: Works through Apple's IAP system
4. **Unlimited Access**: Pro users have no scan limits
5. **Monthly Reset**: Free tier resets on 1st of each month (for testing, you can manually reset in database)

## Technical Details

- **Subscription Type**: Auto-renewable monthly subscription
- **Product ID**: `com.clayjohnson75.bookshelfscanner.pro.monthly`
- **Subscription Management**: Users can manage/cancel subscriptions through iOS Settings → Apple ID → Subscriptions
- **Receipt Validation**: Handled server-side for security
- **Subscription Status**: Stored in Supabase database and synced with Apple receipts

## Test Account Information

If you need a test account with Pro subscription already activated, please contact us. We can provide:
- Test account credentials
- Sandbox test account details
- Manual Pro account activation for testing

## Additional Notes

- The app uses Supabase for backend data storage and subscription management
- Scan limits are enforced both client-side and server-side
- Subscription status is checked before each scan attempt
- Monthly scan counts reset automatically on the 1st of each month
- Pro subscription provides immediate access to unlimited scans upon purchase

## Support

If you encounter any issues during review or need additional test accounts, please contact us through App Store Connect.



