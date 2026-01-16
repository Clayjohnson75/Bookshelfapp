# Apple Review Fix - Terms of Use Links

## Problem
Apple rejected the app because the Terms of Use (EULA) link is missing from the in-app subscription flow.

## Solution
We've already fixed the code. Now we need to:
1. Rebuild the app with the fixes
2. Update App Store Connect metadata

---

## Step 1: Rebuild the App

The current TestFlight build doesn't have the Terms/Privacy links fix. You need to rebuild:

```bash
# Option A: Use your existing build script
./deploy-build-33.sh  # (or create deploy-build-34.sh with updated version)

# Option B: Manual build
git add .
git commit -m "Fix: Add prominent Terms of Use and Privacy Policy links (Apple Guidelines 3.1.2)"
git push
eas build --platform ios --profile production --auto-submit
```

**The fix includes:**
- ✅ Prominent Terms of Use (EULA) link button above subscription info
- ✅ Privacy Policy link button  
- ✅ Additional links at bottom for redundancy
- ✅ All links are functional and use `Linking.openURL()`

---

## Step 2: Update App Store Connect Metadata

You MUST update App Store Connect after rebuilding:

### 2A. Add Terms of Use to App Description

1. Go to **App Store Connect** → Your App → **App Information**
2. Click on **App Description** (or go to **App Store** → **Product Page**)
3. Add this line at the **END** of your app description:

```
Terms of Use: https://bookshelfscan.app/terms.html
Privacy Policy: https://bookshelfscan.app/privacy.html
```

### 2B. Add Privacy Policy URL (if not already there)

1. Go to **App Store Connect** → Your App → **App Information**
2. Find **Privacy Policy URL** field
3. Enter: `https://bookshelfscan.app/privacy.html`
4. Click **Save**

### 2C. (Optional) Add Custom EULA

If you want to use a custom EULA instead of adding it to the description:

1. Go to **App Store Connect** → Your App → **App Information**
2. Scroll to **License Agreement** section
3. Click **Edit** next to "Custom License Agreement"
4. Upload or paste your Terms of Use text
5. Click **Save**

**Note:** You can do EITHER 2A (add to description) OR 2C (custom EULA), not both. Option 2A is simpler.

---

## Step 3: Test Before Submitting

Before submitting to review, test in TestFlight:

1. Install the new build from TestFlight
2. Open the app and navigate to the upgrade/subscription screen
3. Verify you can see:
   - ✅ "Terms of Use (EULA)" button (prominent, above benefits)
   - ✅ "Privacy Policy" button (prominent, above benefits)
   - ✅ Both buttons open the respective web pages when tapped
   - ✅ Additional small links at bottom

---

## What Was Fixed in the Code

### File: `components/UpgradeModal.tsx`

1. **Added prominent Legal Links section** (lines 175-189):
   - Large, visible buttons for Terms and Privacy
   - Placed above the subscription benefits
   - Clearly labeled "Terms of Use (EULA)"

2. **Kept backup links at bottom** (lines 237-251):
   - Additional small links for redundancy

3. **All links are functional**:
   - Terms: `https://bookshelfscan.app/terms.html`
   - Privacy: `https://bookshelfscan.app/privacy.html`
   - Uses React Native's `Linking.openURL()` which is fully functional

---

## Verification Checklist

Before submitting to Apple Review:

- [ ] App rebuilt with latest code (including Terms/Privacy links)
- [ ] TestFlight build tested - links work and are visible
- [ ] App Description updated with Terms link
- [ ] Privacy Policy URL set in App Store Connect
- [ ] All required subscription info visible in app:
  - [ ] Subscription title
  - [ ] Subscription length
  - [ ] Price
  - [ ] Terms of Use link (functional)
  - [ ] Privacy Policy link (functional)

---

## Common Issues

**"Links don't work in TestFlight"**
- Make sure you tested the actual TestFlight build, not just Expo Go
- Check that URLs are accessible (try opening in Safari)

**"Apple still says links are missing"**
- Make sure you updated BOTH the app code AND App Store metadata
- The links must be visible BEFORE the purchase button (which they are - they're above the benefits section)

**"Links are too small/hidden"**
- The current implementation has prominent buttons that should be easily visible
- They appear in a white card above the benefits section

---

## After Submission

Once Apple approves:
- ✅ Keep these links in all future builds
- ✅ Don't remove them or hide them
- ✅ If you update Terms/Privacy, make sure links still work

