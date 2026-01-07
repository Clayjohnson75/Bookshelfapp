# App Store Review Fixes

## Issue 1: Promotional Image (Guideline 2.3.2)

**Problem:** Promotional image is the same as app icon.

**Solution Options:**

### Option A: Remove Promotional Image (Recommended if not promoting IAP)
1. Go to App Store Connect
2. Navigate to your app → Features → In-App Purchases
3. Find "Pro Monthly Subscription"
4. Remove or delete the promotional image
5. Save changes

### Option B: Create Unique Promotional Image
1. Create a new promotional image (1024x1024px or 1024x500px)
2. Image should show:
   - "Pro" or "Upgrade to Pro" text
   - Subscription benefits (e.g., "Unlimited Scans")
   - Different from app icon
3. Upload in App Store Connect → In-App Purchases → Promotional Image

---

## Issue 2: Permission Strings (Guideline 5.1.1) ✅ FIXED

**Status:** Updated permission strings in both `app.json` and `app.config.js` to be more specific with clear examples.

**Changes Made:**
- Camera permission now explains: "Bookshelf Scanner needs access to your camera to take photos of your bookshelf. When you take a photo, the app uses AI to automatically identify book titles and authors from the book spines visible in the image. For example, if you photograph a bookshelf containing 'The Great Gatsby' by F. Scott Fitzgerald, the app will detect and catalog this book automatically."

- Photo library permission now explains: "Bookshelf Scanner needs access to your photo library to select existing photos of bookshelves. When you choose a photo, the app uses AI to automatically identify book titles and authors from the book spines visible in the image. For example, if you select a photo of your bookshelf, the app will scan it and add all detected books like 'To Kill a Mockingbird' by Harper Lee to your digital library."

---

## Issue 3: In-App Purchase Not Found (Guideline 2.1)

**Problem:** Apple reviewers cannot find the IAP product in the submitted binary.

**Current Implementation:**
- IAP is implemented in `services/appleIAPService.ts`
- Product ID: `com.bookshelfscanner.pro.monthly`
- UpgradeModal is shown when users hit scan limit (5 scans for free users)
- IAP is initialized when UpgradeModal opens

**How Reviewers Can Find It:**
1. Sign in to the app
2. Go to the "Scans" tab
3. Attempt to scan more than 5 times (free account limit)
4. The UpgradeModal will appear with the "Pro Monthly Subscription" option
5. Tap "Upgrade to Pro" to see the purchase flow

**If IAP Still Not Found:**

### Option A: Remove IAP from App Store Connect (if not ready)
1. App Store Connect → Your App → Features → In-App Purchases
2. Delete "Pro Monthly Subscription" product
3. Resubmit app without IAP

### Option B: Ensure IAP is Properly Configured
1. Verify product ID matches: `com.bookshelfscanner.pro.monthly`
2. Ensure product is "Ready to Submit" in App Store Connect
3. Make sure product is associated with the app version
4. Reply to Apple review explaining where to find it:
   - "The Pro Monthly Subscription can be found by: 1) Signing in to the app, 2) Going to the Scans tab, 3) Attempting to scan more than 5 times (free account limit), 4) The upgrade modal will appear with the subscription option."

---

## Next Steps

1. **Push permission string fixes** (already done in code)
2. **Remove or update promotional image** in App Store Connect
3. **Reply to Apple review** explaining where to find the IAP, or remove it if not ready
4. **Rebuild and resubmit** the app

