# In-App Purchase Testing Guide

## Current Issue: "undefined is not a function"

This error occurs when trying to purchase Pro. The code now includes better error logging to identify which function is undefined.

## Testing Steps

### 1. Check Your Environment

**❌ Won't Work:**
- Expo Go (IAP doesn't work in Expo Go)
- iOS Simulator (IAP requires real device or TestFlight)

**✅ Will Work:**
- Development build (EAS build)
- TestFlight build
- Physical iOS device

### 2. Check Console Logs

When you click "Purchase", check the console for these logs:

```
🔍 Getting IAP module...
✅ IAP module loaded. Available methods: [...]
🔌 Initializing IAP connection...
✅ IAP connection initialized
✅ Setting up purchase listeners...
🛒 Requesting purchase for product: com.bookshelfscanner.pro.monthly
```

**If you see errors like:**
- `❌ IAP module missing purchaseUpdatedListener method` → The module isn't loading correctly
- `❌ purchaseUpdatedListener is not a function` → The API structure is wrong
- `❌ IAP module is null` → The module failed to import

### 3. Verify Product ID

Make sure the product ID matches App Store Connect:
- Current product ID: `com.bookshelfscanner.pro.monthly`
- Check in: App Store Connect → Your App → Features → In-App Purchases

### 4. Test with Sandbox Account

1. **Create Sandbox Tester:**
   - App Store Connect → Users and Access → Sandbox Testers
   - Create a new sandbox tester account

2. **Sign Out of Real Apple ID:**
   - Settings → App Store → Sign Out (on your test device)

3. **Try Purchase:**
   - Open the app
   - Click "Upgrade to Pro"
   - When prompted, sign in with sandbox account
   - Complete the purchase

### 5. Common Issues & Fixes

#### Issue: "IAP module not available"
**Fix:** Make sure you're using a development build or TestFlight, not Expo Go

#### Issue: "Product not found"
**Fix:** 
- Verify product ID in App Store Connect matches code
- Make sure product is in "Ready to Submit" or "Approved" status
- Wait a few minutes after creating product (propagation delay)

#### Issue: "purchaseUpdatedListener is not a function"
**Fix:**
- Check console logs to see available methods
- May need to rebuild the app: `eas build --platform ios`
- Check if `react-native-iap` is properly linked

#### Issue: "User cancelled purchase"
**Fix:** This is normal - user cancelled the purchase dialog

### 6. Debug Checklist

- [ ] Using development build or TestFlight (not Expo Go)
- [ ] Testing on physical device or TestFlight
- [ ] Product ID matches App Store Connect
- [ ] Product status is "Ready to Submit" or "Approved"
- [ ] Signed out of real Apple ID
- [ ] Using sandbox tester account
- [ ] Check console logs for specific error
- [ ] Rebuild app if methods are undefined

### 7. Console Logging

The code now logs:
- ✅ When IAP module loads
- ✅ Available methods on the module
- ✅ When connection initializes
- ✅ When purchase listeners are set up
- ✅ When purchase is requested
- ❌ Which specific function is undefined (if any)

**Check your console/terminal for these logs to identify the exact issue.**

### 8. If Still Not Working

1. **Check react-native-iap version:**
   ```bash
   npm list react-native-iap
   ```
   Should be `^14.7.0`

2. **Rebuild the app:**
   ```bash
   eas build --platform ios --profile development
   ```

3. **Check native linking:**
   - For Expo managed workflow, this should be automatic
   - If using bare workflow, may need to run `pod install` in `ios/` folder

4. **Check App Store Connect:**
   - Product exists and is approved
   - App version matches the build
   - In-App Purchase capability is enabled

## Next Steps

1. Try the purchase again
2. Check console logs for the specific error
3. Share the console output if the issue persists
4. The improved error messages will tell us exactly which function is undefined

