# Owner Account Setup

## Overview
An "owner" tier has been added to the subscription system. Owner accounts get all pro features plus additional features that can be added in the future.

## What Was Changed

### 1. Database Schema
- Updated `subscription_tier` constraint to allow 'owner' tier
- Updated `can_user_scan()` function to allow owner accounts unlimited scans
- Updated `get_user_scan_usage()` function to handle owner accounts (unlimited scans)

### 2. Code Updates
- Updated `subscriptionService.ts` to support 'owner' tier
- Updated `ScanLimitBanner.tsx` to hide banner for owner accounts
- Owner accounts are treated the same as pro for scan limits (unlimited)

## Setup Instructions

### Step 1: Run the Owner Tier Migration
Run this SQL in your Supabase SQL Editor:
```sql
-- File: supabase-migration-add-owner-tier.sql
```
This will:
- Add 'owner' to the subscription_tier constraint
- Update the database functions to recognize owner accounts

### Step 2: Set Your Account to Owner
Run this SQL in your Supabase SQL Editor:
```sql
-- File: supabase-set-owner-account.sql
```
This will:
- Set the user with username "clay" to owner tier
- Set subscription status to active
- Verify the update

## Owner Account Features

Currently, owner accounts get:
- ✅ Unlimited scans (same as pro)
- ✅ All pro features
- ✅ No scan limit banner
- ✅ Ready for additional features in the future

## Future Owner-Only Features

You can add owner-only features by checking the subscription tier:
```typescript
const tier = await getUserSubscriptionTier(userId);
if (tier === 'owner') {
  // Owner-only feature code
}
```

## Verification

After running the SQL scripts, verify your account:
1. Check your profile in Supabase:
   ```sql
   SELECT username, subscription_tier, subscription_status 
   FROM profiles 
   WHERE username = 'clay';
   ```
2. In the app, you should see:
   - No scan limit banner
   - Unlimited scans
   - All pro features active





