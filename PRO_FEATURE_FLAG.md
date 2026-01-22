# Pro Feature Flag - Enable Pro for Everyone

## Overview

A feature flag has been added to temporarily enable all Pro features for everyone. This allows you to submit a build to Apple where all users get unlimited scans and Pro features, without losing any of the subscription code.

## How to Toggle

### Enable Pro for Everyone (Current State)

**File:** `services/subscriptionService.ts`  
**Line:** ~10

```typescript
const ENABLE_PRO_FOR_EVERYONE = true; // ⚠️ CHANGE THIS TO false TO RE-ENABLE SUBSCRIPTIONS
```

Set to `true` to enable Pro features for everyone.

### Disable (Re-enable Subscriptions)

Change the same line to:

```typescript
const ENABLE_PRO_FOR_EVERYONE = false; // Subscriptions enabled
```

Then rebuild the app.

## What This Does

When `ENABLE_PRO_FOR_EVERYONE = true`:

✅ **All users get 'pro' tier**
- `checkSubscriptionStatus()` returns `'pro'` for everyone
- `getUserSubscriptionTier()` returns `'pro'` for everyone

✅ **Unlimited scans for everyone**
- `canUserScan()` always returns `true`
- `getUserScanUsage()` returns unlimited (null limits)

✅ **All Pro features unlocked**
- No scan limits
- All premium features available
- No upgrade prompts

## Files Updated

The feature flag is checked in:

1. **Client-side:**
   - `services/subscriptionService.ts` - Main subscription checks
   - `services/appleIAPService.ts` - IAP subscription checks

2. **Server-side APIs:**
   - `api/check-subscription.ts` - Subscription status API
   - `api/library/ask.ts` - Pro requirement checks

## Server-Side Note

For server-side APIs (`api/check-subscription.ts` and `api/library/ask.ts`), the flag uses an environment variable:

```bash
ENABLE_PRO_FOR_EVERYONE=true
```

**Important:** If you're using Vercel or similar, you'll need to set this environment variable in your deployment settings.

Alternatively, you can hardcode it in those files if needed (same pattern as client-side).

## Testing

1. **Set flag to `true`** in `services/subscriptionService.ts`
2. **Rebuild the app:**
   ```bash
   eas build --platform ios --profile production
   ```
3. **Test that:**
   - All users can scan unlimited times
   - No scan limit banners appear
   - Upgrade modal doesn't show (or shows "Pro Account Active")
   - All Pro features work

## Re-enabling Subscriptions Later

When you're ready to re-enable subscriptions:

1. **Change flag to `false`** in `services/subscriptionService.ts`
2. **Remove or set to false** the `ENABLE_PRO_FOR_EVERYONE` env var in your server
3. **Rebuild the app**
4. **Test subscriptions work correctly**

All subscription code remains intact - just change one boolean value!

## Current Status

✅ **Pro features enabled for everyone** (`ENABLE_PRO_FOR_EVERYONE = true`)

This means:
- Everyone gets unlimited scans
- All Pro features are unlocked
- No subscription checks are performed
- Perfect for submitting to Apple while IAP is being fixed

## Important Notes

- ⚠️ **The flag must be set before building** - it's compiled into the app
- ⚠️ **Server-side APIs need the env var** - set `ENABLE_PRO_FOR_EVERYONE=true` in Vercel/env
- ⚠️ **All subscription code is preserved** - just disabled, not removed
- ✅ **Easy to toggle back** - change one value and rebuild

## Quick Reference

| Action | Change |
|--------|--------|
| Enable Pro for everyone | `ENABLE_PRO_FOR_EVERYONE = true` |
| Re-enable subscriptions | `ENABLE_PRO_FOR_EVERYONE = false` |
| Server-side (Vercel) | Set env var: `ENABLE_PRO_FOR_EVERYONE=true` |

