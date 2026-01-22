# In-App Purchase Troubleshooting Guide

## Current Issue: "Purchase Unavailable" Error

This guide helps you diagnose and fix the "Purchase Unavailable" error message.

## Quick Diagnosis Checklist

### 1. Environment Check
- [ ] **NOT using Expo Go** - IAP doesn't work in Expo Go
- [ ] **Using development build or TestFlight** - Required for IAP
- [ ] **Testing on physical device** - Simulator doesn't support IAP
- [ ] **iOS device** - Android IAP not implemented

### 2. App Store Connect Configuration
- [ ] **Product exists** - Check App Store Connect → Your App → Features → In-App Purchases
- [ ] **Product ID matches** - Should be `com.bookshelfscanner.pro.monthly.v2`
- [ ] **Product status** - Must be "Ready to Submit" or "Approved"
- [ ] **Product included in submission** - Must be added to app version
- [ ] **Paid Apps Agreement** - Must be accepted in App Store Connect

### 3. Testing Setup
- [ ] **Sandbox tester created** - App Store Connect → Users and Access → Sandbox Testers
- [ ] **Signed out of real Apple ID** - Settings → App Store → Sign Out
- [ ] **Using sandbox account** - Will be prompted during purchase

## Common Error Messages & Solutions

### "In-app purchases are not available right now"
**Causes:**
1. Testing in Expo Go (IAP doesn't work)
2. Product not configured in App Store Connect
3. Product not in "Ready to Submit" state
4. Network/connection issues

**Solutions:**
1. Use development build: `eas build --platform ios --profile development`
2. Verify product in App Store Connect
3. Ensure product status is "Ready to Submit"
4. Check internet connection

### "Subscription Not Found"
**Causes:**
1. Product ID mismatch
2. Product not approved/ready
3. Product not included in app submission

**Solutions:**
1. Verify product ID: `com.bookshelfscanner.pro.monthly.v2`
2. Check App Store Connect product status
3. Add product to app version in App Store Connect

### "Initialization Error"
**Causes:**
1. IAP module not loading correctly
2. react-native-iap not properly linked
3. App needs restart

**Solutions:**
1. Rebuild app: `eas build --platform ios`
2. Check `react-native-iap` is installed: `npm list react-native-iap`
3. Restart app completely

### "Purchase System Unavailable"
**Causes:**
1. Using Expo Go
2. Testing on simulator
3. react-native-iap not installed

**Solutions:**
1. Use development build or TestFlight
2. Test on physical device
3. Verify package.json includes `react-native-iap`

## Step-by-Step Testing Process

### Step 1: Verify Product in App Store Connect

1. Go to [App Store Connect](https://appstoreconnect.apple.com)
2. Navigate to: Your App → Features → In-App Purchases
3. Verify product exists with ID: `com.bookshelfscanner.pro.monthly.v2`
4. Check status is "Ready to Submit" or "Approved"
5. Ensure product is added to your app version

### Step 2: Create Sandbox Tester

1. App Store Connect → Users and Access → Sandbox Testers
2. Click "+" to create new tester
3. Use a unique email (can be fake, e.g., `test@example.com`)
4. Save the tester

### Step 3: Build Development Version

```bash
# Build development version
eas build --platform ios --profile development

# Or build for TestFlight
eas build --platform ios --profile production
```

### Step 4: Install on Device

1. Download the build from EAS or TestFlight
2. Install on physical iOS device
3. **Important:** Sign out of your real Apple ID:
   - Settings → App Store → Sign Out

### Step 5: Test Purchase

1. Open the app
2. Navigate to upgrade/subscription screen
3. Tap "Subscribe to Pro"
4. When prompted, sign in with sandbox tester account
5. Complete the purchase

### Step 6: Check Console Logs

Look for these logs in your console/terminal:

**Success logs:**
```
🔍 Getting IAP module...
✅ IAP module loaded
🔌 Initializing IAP connection...
✅ IAP connection initialized
🔍 Getting products...
✅ getProducts returned: 1 products
✅ Product verified: { productId: '...', title: '...', price: '...' }
✅ Setting up purchase listeners...
🛒 Requesting purchase for product: com.bookshelfscanner.pro.monthly.v2
✅ Purchase successful
```

**Error logs to watch for:**
- `❌ IAP module is null` → Not using development build
- `❌ No products found` → Product not configured correctly
- `❌ Product ID mismatch` → Wrong product ID
- `❌ initConnection failed` → IAP module issue

## Debugging Commands

### Check react-native-iap version
```bash
npm list react-native-iap
```
Should show: `react-native-iap@14.7.0`

### Rebuild app
```bash
eas build --platform ios --profile development
```

### Check product ID in code
```bash
grep -r "PRODUCT_ID" services/appleIAPService.ts
```
Should show: `const PRODUCT_ID = 'com.bookshelfscanner.pro.monthly.v2';`

## Product Configuration Checklist

In App Store Connect, verify:

- [ ] **Product Type:** Auto-Renewable Subscription
- [ ] **Product ID:** `com.bookshelfscanner.pro.monthly.v2`
- [ ] **Reference Name:** Pro Monthly Subscription
- [ ] **Subscription Duration:** 1 Month
- [ ] **Price:** Set appropriately
- [ ] **Status:** Ready to Submit or Approved
- [ ] **Localization:** All required languages filled
- [ ] **Subscription Group:** Created and assigned
- [ ] **Included in App Version:** Product added to app submission

## Network & Connection Issues

If you see network errors:

1. **Check internet connection** - IAP requires internet
2. **Try different network** - Some networks block App Store
3. **Wait a few minutes** - App Store servers may be slow
4. **Check device time** - Incorrect time can cause issues

## Still Not Working?

### 1. Check Console Logs
The app now logs detailed error information. Look for:
- Error codes (e.g., `E_ITEM_UNAVAILABLE`, `E_SERVICE_ERROR`)
- Specific error messages
- Which function failed

### 2. Verify Product Propagation
After creating/updating a product in App Store Connect:
- Wait 5-10 minutes for propagation
- Try again after waiting

### 3. Test with Different Account
- Create a new sandbox tester
- Sign out completely
- Try purchase again

### 4. Rebuild App
Sometimes a rebuild fixes module loading issues:
```bash
eas build --platform ios --profile development
```

### 5. Check App Store Connect Status
- Ensure app is in "Ready for Sale" or "Pending Developer Release"
- Verify In-App Purchase capability is enabled
- Check Paid Apps Agreement is accepted

## Testing Checklist Summary

Before testing, ensure:

- [ ] Using development build or TestFlight (NOT Expo Go)
- [ ] Testing on physical iOS device (NOT simulator)
- [ ] Product exists in App Store Connect
- [ ] Product ID matches: `com.bookshelfscanner.pro.monthly.v2`
- [ ] Product status is "Ready to Submit" or "Approved"
- [ ] Product included in app submission
- [ ] Sandbox tester created
- [ ] Signed out of real Apple ID
- [ ] Internet connection available
- [ ] Console logs checked for specific errors

## Getting Help

If you've tried everything and it's still not working:

1. **Collect logs:**
   - Copy all console output when purchase fails
   - Note the exact error message shown to user
   - Check which step failed (initialization, product fetch, purchase)

2. **Verify configuration:**
   - Product ID in code matches App Store Connect
   - Product status in App Store Connect
   - App build type (development/TestFlight)

3. **Test environment:**
   - Device type (physical vs simulator)
   - Build type (development vs Expo Go)
   - Network connection

## Additional Resources

- [Apple In-App Purchase Documentation](https://developer.apple.com/in-app-purchase/)
- [react-native-iap Documentation](https://github.com/dooboolab/react-native-iap)
- [App Store Connect Help](https://help.apple.com/app-store-connect/)

