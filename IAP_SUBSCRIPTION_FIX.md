# IAP Subscription Fix - Using Correct Methods

## Problem Identified

The app was using **`getProducts()`** and **`requestPurchase()`** for auto-renewable subscriptions, but should use:
- **`getSubscriptions()`** - to fetch subscription products
- **`requestSubscription()`** - to purchase subscriptions

## What Was Fixed

### 1. Product ID ✅
- **Already correct:** `const PRODUCT_ID = 'com.bookshelfscanner.pro.monthly.v2';`
- Matches App Store Connect product ID

### 2. Changed `getProducts()` → `getSubscriptions()` ✅

**Before:**
```typescript
products = await getProductsMethod({ skus: [PRODUCT_ID] });
```

**After:**
```typescript
// Priority: getSubscriptions first (correct for subscriptions)
if (typeof iap.getSubscriptions === 'function') {
  getSubscriptionsMethod = iap.getSubscriptions;
  products = await getSubscriptionsMethod({ skus: [PRODUCT_ID] });
}
```

**Locations updated:**
- `initializeIAP()` - Line ~161-203
- `purchaseProSubscription()` - Line ~395-445
- `validateProductAvailability()` - Line ~280-316

### 3. Changed `requestPurchase()` → `requestSubscription()` ✅

**Before:**
```typescript
await iap.requestPurchase({ sku: PRODUCT_ID });
```

**After:**
```typescript
// Priority: requestSubscription first (correct for subscriptions)
if (typeof iap.requestSubscription === 'function') {
  await iap.requestSubscription({ sku: PRODUCT_ID });
} else if (typeof iap.requestPurchase === 'function') {
  // Fallback
  await iap.requestPurchase({ sku: PRODUCT_ID });
}
```

**Location updated:**
- `purchaseProSubscription()` - Line ~643-699

### 4. Enhanced Diagnostic Logging ✅

Added instant diagnostic that shows:
- What subscriptions are returned from Apple
- Whether array is empty (product ID/availability issue)
- Exact product IDs found vs expected

## react-native-iap v14.7.0 API

For **react-native-iap v14.7.0**, the correct API for subscriptions is:

```typescript
import { getSubscriptions, requestSubscription } from 'react-native-iap';

// Fetch subscriptions
const subs = await getSubscriptions({ skus: [PRODUCT_ID] });

// Purchase subscription
await requestSubscription({ sku: PRODUCT_ID });
```

**Parameter format:** Uses `{ skus: [...] }` (not `productIds`)

## Testing Steps

### 1. Rebuild App
```bash
eas build --platform ios --profile development
```

**Important:** You MUST rebuild because the old build was compiled with the wrong methods.

### 2. Install on Device
- Install new build on physical iOS device
- Sign out of real Apple ID (Settings → App Store → Sign Out)

### 3. Test Purchase
1. Open app
2. Navigate to upgrade screen
3. Tap "Subscribe to Pro"
4. Check console logs for:

```
🔍 INSTANT DIAGNOSTIC: Subscriptions from Apple
🔍 Requested Product ID: com.bookshelfscanner.pro.monthly.v2
🔍 Subscriptions array length: [number]
```

### 4. Expected Console Output

**If working:**
```
✅ Using getSubscriptions() for subscription products
✅ Subscriptions found:
   [0] Product ID: com.bookshelfscanner.pro.monthly.v2
       Title: Pro Monthly Subscription
       Price: $4.99
✅ Expected product ID found: com.bookshelfscanner.pro.monthly.v2
✅ Using requestSubscription() for subscription purchase
```

**If not working (empty array):**
```
❌ EMPTY ARRAY - This means:
   → Product ID mismatch
   → Product not available in App Store Connect
   → Wrong bundle ID
   → Wrong storefront
   → Product not in "Ready to Submit" state
```

## Key Changes Summary

| What | Before | After |
|------|--------|-------|
| Fetch products | `getProducts()` | `getSubscriptions()` ✅ |
| Purchase | `requestPurchase()` | `requestSubscription()` ✅ |
| Product ID | Already correct | `com.bookshelfscanner.pro.monthly.v2` ✅ |
| Diagnostic | Basic | Enhanced with instant feedback ✅ |

## Next Steps

1. **Rebuild app** - Old build has wrong methods
2. **Test on device** - Not simulator, not Expo Go
3. **Check console logs** - Look for diagnostic output
4. **Verify product in App Store Connect** - Ensure status is "Ready to Submit" or "Approved"

## Why This Matters

- **`getProducts()`** is for one-time purchases, not subscriptions
- **`getSubscriptions()`** is specifically for auto-renewable subscriptions
- Using the wrong method can result in empty arrays even when product exists
- Apple's StoreKit expects subscription-specific methods for subscriptions

## Files Changed

- `services/appleIAPService.ts`
  - `initializeIAP()` - Now uses `getSubscriptions()`
  - `purchaseProSubscription()` - Now uses `getSubscriptions()` and `requestSubscription()`
  - `validateProductAvailability()` - Now uses `getSubscriptions()`

## Verification

After rebuild, the console should show:
- ✅ `Using getSubscriptions() for subscription products`
- ✅ `Using requestSubscription() for subscription purchase`
- ✅ Subscriptions array with your product ID

If you see empty array, check:
- Product ID matches App Store Connect exactly
- Product status in App Store Connect
- Bundle ID matches
- Using sandbox account for testing

