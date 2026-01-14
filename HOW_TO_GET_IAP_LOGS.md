# How to Get IAP Purchase Error Logs

## The Error is Client-Side, Not Server-Side

The "undefined is not a function" error happens in your **React Native app** (on the device), not on the Vercel server. The Vercel logs you shared are server-side and won't show this error.

## Where to Find the Logs

### Option 1: Metro Bundler Console (Easiest)

If you're running the app with `expo start` or `npx expo start`:

1. **Look at your terminal** where Expo is running
2. **Try to purchase** in the app
3. **Check the terminal** for logs like:
   - `🔍 Getting IAP module...`
   - `✅ IAP module loaded. Available methods: [...]`
   - `❌ purchaseUpdatedListener is not a function`
   - `❌ requestPurchase is not a function`
   - Any error messages

### Option 2: Xcode Console (iOS Device/Simulator)

If you're testing on iOS:

1. **Open Xcode**
2. **Window → Devices and Simulators**
3. **Select your device**
4. **Click "Open Console"**
5. **Filter by your app name** or search for "IAP"
6. **Try to purchase** in the app
7. **Check the console** for the error logs

### Option 3: React Native Debugger

If you have React Native Debugger open:

1. **Open the Console tab**
2. **Try to purchase** in the app
3. **Check the console** for logs

### Option 4: Device Logs (Physical Device)

If testing on a physical device:

1. **Connect device to Mac**
2. **Open Console.app** (macOS app)
3. **Select your device** from the sidebar
4. **Filter by your app name**
5. **Try to purchase**
6. **Check the logs**

## What to Look For

When you try to purchase, you should see logs like:

```
🔍 Getting IAP module...
📦 IAP module loaded: { hasDefault: true, ... }
✅ IAP module loaded. Available methods: [...]
🔍 Checking specific methods:
  - initConnection: function
  - purchaseUpdatedListener: undefined  ← THIS IS THE PROBLEM
  - purchaseErrorListener: undefined
  - requestPurchase: function
```

**The key is to find which method shows as `undefined` instead of `function`.**

## Quick Test

If you can't see logs easily, try this:

1. **Add a console.log right before the purchase:**
   - The code already has this, but make sure you're looking at the right place

2. **Check the error message:**
   - The error should say something like "purchaseUpdatedListener is not a function"
   - Or "requestPurchase is not a function"
   - This tells us exactly what's wrong

## What I Need From You

Please share:
1. **The exact error message** (from the alert or console)
2. **Any console logs** that start with 🔍, ✅, or ❌
3. **Which method is undefined** (if you can see it)

The logs I added should show exactly which function is missing!

