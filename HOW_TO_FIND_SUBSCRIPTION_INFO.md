# How to Find Your Subscription Information

## Step 1: Check App Store Connect

### Go to App Store Connect
1. Open your browser and go to: **https://appstoreconnect.apple.com**
2. Sign in with your Apple Developer account
3. Click **"My Apps"** in the top navigation
4. Click on your app: **"Bookshelf Scanner"** (or whatever you named it)

### Check if Subscription Exists
1. In the left sidebar, look for **"Features"** or **"In-App Purchases"**
2. Click on it
3. Look for any subscriptions listed

**If you see subscriptions:**
- Click on the subscription
- Look for **"Product ID"** - this is what we need!
- Copy it exactly (e.g., `com.clayjohnson75.bookshelf-scanner.pro.monthly`)

**If you DON'T see any subscriptions:**
- You need to create one first (see Step 2 below)

---

## Step 2: Create Subscription (If It Doesn't Exist)

### Create Subscription Group
1. In App Store Connect, go to your app
2. Click **"Features"** → **"In-App Purchases"**
3. Click the **"+"** button
4. Select **"New Subscription Group"**
5. Name it: **"Pro Subscription"** (or any name)
6. Click **"Create"**

### Create the Subscription Product
1. Inside the subscription group, click **"+"** → **"New Subscription"**
2. Fill out:
   - **Reference Name**: `Pro Monthly` (internal name, you'll see this)
   - **Product ID**: `com.clayjohnson75.bookshelf-scanner.pro.monthly` ⚠️ **IMPORTANT: This must match your Bundle ID prefix!**
   - **Subscription Duration**: Select **"1 Month"**
   - **Price**: Choose your price (e.g., $4.99/month)
3. Click **"Create"**

### Complete Subscription Details
1. Add **Subscription Display Name**: `Pro Monthly`
2. Add **Description**: `Unlimited book scans per month`
3. Upload a **Review Screenshot** (required by Apple)
4. Add **Review Notes** (optional, but helpful)
5. Click **"Save"**

### Submit for Review
1. The subscription should show as **"Ready to Submit"**
2. You can submit it with your next app version, or submit it separately

---

## Step 3: Check Your Bundle ID

### In App Store Connect
1. Go to your app in App Store Connect
2. Click **"App Information"** in the left sidebar
3. Look for **"Bundle ID"** - it should be: `com.clayjohnson75.bookshelf-scanner`

### In Your Code
Check `app.config.js` or `app.json`:
- Look for `bundleIdentifier` (iOS)
- Should match: `com.clayjohnson75.bookshelf-scanner`

**Your Product ID should be:**
`com.clayjohnson75.bookshelf-scanner.pro.monthly`

---

## Step 4: Check Which IAP Library You're Using

### Check package.json
1. Open `package.json` in your project
2. Look for either:
   - `expo-storekit` - means you're using Expo's StoreKit
   - `react-native-iap` - means you're using the third-party library

### Check Your Code
- If you see `import * as StoreKit from 'expo-storekit'` → Use `storeKitService.ts`
- If you see `import * as InAppPurchase from 'react-native-iap'` → Use `appleIAPService.ts`

---

## Step 5: Quick Checklist

Before connecting the subscription, make sure:

- [ ] Subscription created in App Store Connect
- [ ] Product ID matches: `com.clayjohnson75.bookshelf-scanner.pro.monthly` (or whatever you created)
- [ ] Bundle ID matches: `com.clayjohnson75.bookshelf-scanner`
- [ ] Subscription is in "Ready to Submit" or "Approved" status
- [ ] You know which IAP library you're using (expo-storekit or react-native-iap)

---

## Common Issues

### "Product ID doesn't match"
- Product ID must start with your Bundle ID
- Example: Bundle ID = `com.clayjohnson75.bookshelf-scanner`
- Product ID = `com.clayjohnson75.bookshelf-scanner.pro.monthly` ✅

### "Unknown Product" error
- Product ID typo
- Subscription not approved in App Store Connect
- Not signed in with sandbox account on device

### "Subscription not found"
- Make sure subscription is in "Ready to Submit" or "Approved" status
- Wait a few minutes after creating (Apple needs to sync)

---

## What to Tell Me

Once you've checked everything, tell me:

1. **Product ID**: `com.clayjohnson75.bookshelf-scanner.pro.monthly` (or whatever you found/created)
2. **Subscription Status**: "Ready to Submit" or "Approved" or "Doesn't exist yet"
3. **IAP Library**: "expo-storekit" or "react-native-iap" (check package.json)
4. **Bundle ID**: `com.clayjohnson75.bookshelf-scanner` (confirm this matches)

Then I can connect everything for you! 🚀


