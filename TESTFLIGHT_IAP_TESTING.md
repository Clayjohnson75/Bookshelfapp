# Testing IAP in TestFlight

## ✅ TestFlight is Correct!

**DO NOT test in Expo Go** - IAP doesn't work there. TestFlight is the right environment.

## How to Get Logs from TestFlight

### Option 1: Xcode Console (Easiest)

1. **Connect your iPhone/iPad to your Mac**
2. **Open Xcode**
3. **Window → Devices and Simulators** (or `Shift+Cmd+2`)
4. **Select your device** from the left sidebar
5. **Click "Open Console"** button (bottom of the window)
6. **In the console, filter by your app name** or search for "IAP" or "Purchase"
7. **Try to purchase** in the TestFlight app
8. **Watch the console** for logs like:
   - `🔍 Getting IAP module...`
   - `📦 IAP module loaded:`
   - `❌` error messages

### Option 2: Console.app (macOS)

1. **Connect your device to Mac**
2. **Open Console.app** (Applications → Utilities → Console)
3. **Select your device** from the left sidebar
4. **In the search box, type your app name** or "IAP"
5. **Try to purchase** in TestFlight
6. **Check the logs** that appear

### Option 3: Check the Error Message

The error alert in the app should tell you which function is undefined:
- "purchaseUpdatedListener is not a function"
- "requestPurchase is not a function"
- etc.

## How to Test the Purchase Flow

### Step 1: Set Up Sandbox Account

1. **App Store Connect** → **Users and Access** → **Sandbox Testers**
2. **Create a sandbox tester account** (if you don't have one)
3. **Note the email and password**

### Step 2: Sign Out of Real Apple ID

1. **On your test device**: Settings → App Store
2. **Sign out** of your real Apple ID
3. **Important**: You must be signed out for sandbox to work

### Step 3: Test Purchase

1. **Open your app in TestFlight**
2. **Sign in** with the demo account (`user_95d737b1`)
3. **Click "Upgrade to Pro"**
4. **When prompted, sign in with sandbox account**
5. **Complete the purchase**

### Step 4: Verify Purchase

After purchase:
- ✅ Account should show as Pro
- ✅ Pro features should work
- ✅ Check Supabase: `subscription_tier` should be `'pro'`

## Current Issue: "undefined is not a function"

This means one of the IAP methods isn't loading correctly. The code I just updated should:
1. Try multiple import patterns
2. Show detailed logs about what's available
3. Fall back to alternative import methods

## Do We Need a New Build?

**YES** - You need a new build because:
- ✅ I just updated the IAP import logic
- ✅ Added better error handling
- ✅ Added fallback import patterns
- ✅ Current TestFlight build has the old code

## Next Steps

1. **Build new version** with the IAP fixes
2. **Submit to TestFlight**
3. **Test again** with the new build
4. **Check logs** using Xcode Console or Console.app
5. **Share the logs** if it still doesn't work

## Quick Test Checklist

- [ ] Using TestFlight (not Expo Go) ✅
- [ ] Signed out of real Apple ID
- [ ] Using sandbox tester account
- [ ] New build with IAP fixes
- [ ] Checked Xcode Console for logs
- [ ] Purchase flow tested

