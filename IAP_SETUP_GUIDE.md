# IAP Subscription Setup Guide - Fix "Product Not Available" Error

## The Problem
Your subscription is showing as "not available" because it's in "Waiting for Review" or "Rejected" state. Apple can't test it until it's properly configured.

## The Solution
The subscription product must be in **"Ready to Submit"** state and submitted **WITH** the app (same submission).

---

## Step-by-Step Fix in App Store Connect

### Step 1: Accept Paid Apps Agreement (CRITICAL)
1. Go to **App Store Connect** → **Agreements, Tax, and Banking**
2. Look for **"Paid Apps Agreement"**
3. If it says "Action Required", click and complete it
4. You MUST accept this before IAP will work

### Step 2: Create/Edit Your Subscription Product
1. Go to **App Store Connect** → **My Apps** → Your App
2. Click **"Features"** tab (or scroll down to "In-App Purchases")
3. Click **"In-App Purchases"**
4. Find your subscription: **"com.bookshelfscanner.pro.monthly"**
   - If it doesn't exist, click **"+"** → **"Auto-Renewable Subscription"**
   - Product ID: `com.bookshelfscanner.pro.monthly`

### Step 3: Complete All Required Fields
Your subscription MUST have all fields filled:

**Required Fields:**
- ✅ **Product ID**: `com.bookshelfscanner.pro.monthly`
- ✅ **Reference Name**: (e.g., "Pro Monthly Subscription")
- ✅ **Subscription Duration**: 1 Month
- ✅ **Price**: Set your price (e.g., $4.99)
- ✅ **Subscription Group**: Create one if needed (e.g., "Bookshelf Scanner Pro")
- ✅ **Localization**: 
  - Display Name: (e.g., "Bookshelf Scanner Pro")
  - Description: (Must be 55 characters or less, e.g., "Unlimited book scans per month with auto-renewing subscription")
- ✅ **Review Information**: 
  - Screenshot (optional but recommended)
  - Review Notes (explain what the subscription does)

**Important**: Make sure there are NO missing required fields (red asterisks)

### Step 4: Set Subscription to "Ready to Submit"
1. After filling all fields, look for the status at the top
2. It should say **"Ready to Submit"** or **"Waiting for Review"**
3. If it says **"Missing Metadata"** or **"Invalid"**, fix the red errors
4. If it says **"Rejected"**, read the rejection reason and fix it

### Step 5: Include Subscription in App Submission
**CRITICAL**: You MUST include the subscription with your app submission:

1. Go to your **app submission** page (when submitting for review)
2. Scroll to **"In-App Purchases"** section
3. Click **"+"** to add the subscription
4. Select **"com.bookshelfscanner.pro.monthly"**
5. Save the submission

**Note**: The subscription should be included in the SAME submission as your app, not submitted separately first.

### Step 6: Test in Sandbox
Before submitting:
1. Create a sandbox tester account in App Store Connect → Users and Access → Sandbox Testers
2. Sign out of your Apple ID on your test device
3. Try to purchase in the app - it will use sandbox
4. Verify the subscription works

---

## Common Issues & Fixes

### Issue: "Product Not Available"
**Cause**: Subscription not in "Ready to Submit" state or not included in app submission  
**Fix**: Follow Steps 1-5 above

### Issue: "Waiting for Review" - Can't Test
**Cause**: Subscription needs to be included with app submission, not submitted separately  
**Fix**: Don't submit subscription separately. Include it with the app submission.

### Issue: "Paid Apps Agreement" Not Accepted
**Cause**: You haven't accepted the agreement  
**Fix**: Go to Agreements, Tax, and Banking → Accept Paid Apps Agreement

### Issue: Subscription Shows "Missing Metadata"
**Cause**: Required fields not filled  
**Fix**: Fill all required fields (marked with red asterisks)

### Issue: Product ID Mismatch
**Cause**: Product ID in code doesn't match App Store Connect  
**Fix**: Verify product ID is exactly: `com.bookshelfscanner.pro.monthly`

---

## Quick Checklist Before Submitting

- [ ] Paid Apps Agreement accepted in App Store Connect
- [ ] Subscription product created with ID: `com.bookshelfscanner.pro.monthly`
- [ ] All required fields filled (no red asterisks)
- [ ] Subscription status is "Ready to Submit" (not "Waiting for Review" separately)
- [ ] Subscription is included in the app submission (same submission)
- [ ] Tested in sandbox (optional but recommended)
- [ ] Terms of Use and Privacy Policy links in app (already fixed)
- [ ] Subscription description is 55 characters or less

---

## What Apple Needs for Review

1. **Subscription must be in "Ready to Submit"** - This means all fields are filled
2. **Subscription included with app** - Submitted together, not separately
3. **Subscription works in sandbox** - Apple tests in sandbox environment
4. **Terms/Privacy links visible** - Already fixed in your app
5. **Paid Apps Agreement accepted** - Required for IAP

---

## Important Notes

- ⚠️ **Don't submit subscription separately** - Include it with your app submission
- ⚠️ **Status "Waiting for Review" is OK** - As long as it's included with app
- ⚠️ **Status "Rejected" needs fixing** - Read rejection reason and fix
- ⚠️ **Sandbox testing is recommended** - Test before submitting to avoid rejections

---

## After Submission

Once submitted:
1. Apple will review BOTH the app AND subscription together
2. They test in sandbox environment
3. If subscription works, both get approved
4. If subscription has issues, they'll reject and tell you what's wrong

---

## If Still Having Issues

If you've followed all steps and still see "Product Not Available":
1. Check App Store Connect → Your App → In-App Purchases → Check status
2. Verify product ID matches exactly: `com.bookshelfscanner.pro.monthly`
3. Make sure subscription is included in your app submission (check submission page)
4. Verify Paid Apps Agreement is accepted
5. Try sandbox testing to see if it works there

The key is: **Subscription must be "Ready to Submit" and included with app submission, not submitted separately.**

