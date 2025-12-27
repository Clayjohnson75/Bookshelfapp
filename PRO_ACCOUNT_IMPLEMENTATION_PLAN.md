# Pro Account Implementation Plan

## Overview
Implement a freemium model with:
- **Free accounts**: 5 scans per month
- **Pro accounts**: Unlimited scans (monthly subscription)

## Implementation Steps

### ✅ Step 1: Database Setup (COMPLETED)
- Run `supabase-migration-add-subscriptions.sql` in Supabase SQL Editor
- This creates:
  - Subscription fields in `profiles` table
  - Monthly scan tracking in `user_stats` table
  - Functions to check scan limits and get usage

### Step 2: Payment Processing Setup

#### Option A: Stripe (Recommended)
1. **Create Stripe Account**
   - Sign up at https://stripe.com
   - Get API keys (publishable key + secret key)
   - Set up webhook endpoint for subscription events

2. **Create Stripe Products**
   - Create a "Pro Subscription" product
   - Set up monthly recurring price (e.g., $4.99/month)
   - Get product and price IDs

3. **Environment Variables**
   Add to Vercel environment variables:
   ```
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_PUBLISHABLE_KEY=pk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_PRICE_ID=price_...
   ```

#### Option B: RevenueCat (Easier for Mobile)
- Handles iOS/Android in-app purchases
- Manages subscriptions across platforms
- Simpler setup but less control

### Step 3: Create API Endpoints

#### `/api/create-checkout-session.ts`
- Creates Stripe checkout session
- Returns session URL for user to complete payment

#### `/api/stripe-webhook.ts`
- Handles Stripe webhook events
- Updates subscription status in Supabase
- Handles: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`

#### `/api/check-subscription.ts`
- Checks user's current subscription status
- Returns tier and usage info

### Step 4: Update Scan Flow

1. **Before Scanning** (`tabs/ScansTab.tsx`)
   - Check `canUserScan()` before allowing scan
   - Show upgrade prompt if limit reached
   - Block scan if free user has used 5 scans

2. **After Scanning** (`api/scan.ts`)
   - Already tracks scans via `trackScan()`
   - Monthly count is automatically incremented

### Step 5: UI Components

1. **Scan Limit Banner** (`components/ScanLimitBanner.tsx`)
   - Shows remaining scans for free users
   - "Upgrade to Pro" button
   - Appears in ScansTab

2. **Upgrade Modal** (`components/UpgradeModal.tsx`)
   - Shows pricing
   - "Subscribe" button → opens Stripe checkout
   - Benefits list

3. **Settings Subscription Section**
   - Current tier display
   - Manage subscription button
   - Cancel subscription option

### Step 6: Testing

1. **Test Free Account**
   - Create test account
   - Verify 5 scan limit
   - Verify scan blocking after limit

2. **Test Pro Account**
   - Upgrade test account (manually in database)
   - Verify unlimited scans
   - Test subscription renewal

3. **Test Stripe Integration**
   - Use Stripe test mode
   - Test checkout flow
   - Test webhook events

## Database Schema

### `profiles` table additions:
- `subscription_tier`: 'free' | 'pro'
- `subscription_status`: 'active' | 'cancelled' | 'past_due' | 'trialing'
- `stripe_customer_id`: Stripe customer ID
- `stripe_subscription_id`: Stripe subscription ID
- `subscription_started_at`: When subscription started
- `subscription_ends_at`: When subscription ends

### `user_stats` table additions:
- `monthly_scans`: Count of scans this month
- `monthly_reset_at`: When monthly count resets

## Functions Available

1. `can_user_scan(user_uuid)` - Returns true/false if user can scan
2. `get_user_scan_usage(user_uuid)` - Returns usage details
3. `increment_user_scan_count(user_uuid)` - Increments scan count (already exists, updated)

## Next Steps

1. ✅ Run database migration
2. Set up Stripe account and get API keys
3. Create API endpoints for checkout and webhooks
4. Add scan limit checks to scan flow
5. Create UI components for upgrade prompts
6. Test end-to-end flow

## Pricing Recommendation

- **Free**: 5 scans/month
- **Pro**: $4.99/month (unlimited scans)
- Consider annual option: $39.99/year (save 33%)

## Notes

- Monthly scans reset automatically on the 1st of each month
- Pro users have unlimited scans (no tracking needed)
- All existing users default to 'free' tier
- Subscription status syncs via Stripe webhooks

