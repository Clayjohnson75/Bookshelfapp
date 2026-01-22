# Quick IAP Testing Guide

## What to Fix

The "Purchase Unavailable" error typically occurs due to one of these issues:

### 1. **Product Not Configured** (Most Common)
- Product doesn't exist in App Store Connect
- Product ID mismatch
- Product not in "Ready to Submit" state
- Product not included in app submission

### 2. **Testing Environment**
- Using Expo Go (won't work)
- Testing on simulator (won't work)
- Not using sandbox account

### 3. **Module Loading Issues**
- react-native-iap not properly installed
- App needs rebuild
- IAP module not initializing

## Quick Fix Steps

### Step 1: Verify Product in App Store Connect
1. Go to [App Store Connect](https://appstoreconnect.apple.com)
2. Your App → Features → In-App Purchases
3. Check product ID: `com.bookshelfscanner.pro.monthly.v2`
4. Status must be "Ready to Submit" or "Approved"
5. Product must be added to app version

### Step 2: Test Environment
```bash
# Build development version
eas build --platform ios --profile development

# Install on physical device (NOT simulator)
# Sign out of real Apple ID in Settings → App Store
```

### Step 3: Test Purchase
1. Open app
2. Go to upgrade screen
3. Tap "Subscribe to Pro"
4. Sign in with sandbox tester when prompted
5. Check console logs for errors

## Console Logs to Check

**Good logs:**
```
✅ IAP module loaded
✅ IAP connection initialized
✅ getProducts returned: 1 products
✅ Product verified
```

**Bad logs:**
```
❌ IAP module is null
❌ No products found
❌ Product ID mismatch
❌ initConnection failed
```

## Common Issues & Quick Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| "Purchase Unavailable" | Product not found | Check App Store Connect product status |
| "IAP module not available" | Using Expo Go | Use development build |
| "Product not available" | Product ID mismatch | Verify product ID in code matches App Store Connect |
| "Initialization Error" | Module not loading | Rebuild app: `eas build --platform ios` |

## Testing Checklist

- [ ] Product exists in App Store Connect
- [ ] Product ID: `com.bookshelfscanner.pro.monthly.v2`
- [ ] Product status: "Ready to Submit" or "Approved"
- [ ] Using development build (NOT Expo Go)
- [ ] Testing on physical device (NOT simulator)
- [ ] Signed out of real Apple ID
- [ ] Sandbox tester created
- [ ] Console logs checked

## Need More Help?

See `IAP_TROUBLESHOOTING.md` for detailed troubleshooting steps.

