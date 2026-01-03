# How to Connect Subscription to App Version

## Step 1: Complete Subscription Metadata

Your subscription shows "Missing Metadata" - you need to complete:

1. Go to **App Store Connect** → Your App → **Features** → **In-App Purchases**
2. Click on your subscription: **Pro Monthly Subscription**
3. Complete all required fields:
   - ✅ **Display Name**: "Pro Monthly"
   - ✅ **Description**: (Enter the description we provided)
   - ✅ **Review Notes**: (Enter the review notes we provided)
   - ✅ **Subscription Image**: Upload a 1024x1024px image
   - ✅ **Subscription Information**: Add benefits/details
4. Click **Save**
5. Status should change from "Missing Metadata" to "Ready to Submit"

## Step 2: Create New App Version

1. Go to **App Store Connect** → Your App → **App Store** tab
2. Click **+ Version** or **+ Platform** (if no version exists)
3. Enter new version number: **1.0.5** (or next version)
4. Fill in "What's New in This Version" section
5. Click **Save**

## Step 3: Connect Subscription to Version

1. On the version page, scroll down to **In-App Purchases and Subscriptions** section
2. Click **+** next to "In-App Purchases and Subscriptions"
3. Select your subscription: **Pro Monthly Subscription** (`com.bookshelfscanner.pro.monthly`)
4. Click **Add**
5. The subscription should now appear in the list

## Step 4: Submit Version for Review

1. Make sure your binary is uploaded (it should be from your latest build)
2. Complete all required sections:
   - App Information
   - Pricing and Availability
   - Version Information
   - Build (select your latest build)
   - In-App Purchases and Subscriptions (should show your subscription)
3. Click **Submit for Review**

## Important Notes

- **First subscription must be submitted with a new app version** - you cannot submit it separately
- **Product ID must match exactly** between App Store Connect and your code
- Your code is now set to: `com.bookshelfscanner.pro.monthly`
- Make sure this matches what's in App Store Connect

## Verification Checklist

- [ ] Subscription metadata is complete (not "Missing Metadata")
- [ ] Subscription status is "Ready to Submit"
- [ ] New app version (1.0.5) is created
- [ ] Subscription is added to version's "In-App Purchases and Subscriptions" section
- [ ] Latest build is selected for the version
- [ ] All required sections are completed
- [ ] Version is submitted for review

## Troubleshooting

### If subscription doesn't appear in version:
- Make sure subscription status is "Ready to Submit" (not "Missing Metadata")
- Try refreshing the page
- Make sure you're on the correct version page

### If Product ID doesn't match:
- App Store Connect: `com.bookshelfscanner.pro.monthly`
- Code: `com.bookshelfscanner.pro.monthly` ✅ (already updated)

### If you need to change Product ID:
- You'll need to delete the subscription in App Store Connect
- Create a new one with the correct Product ID
- Update code to match




