# Apple In-App Purchase Setup Guide

## Step 1: App Store Connect Setup (Do This First!)

### 1.1 Create Subscription Group
1. Go to https://appstoreconnect.apple.com
2. Select your app
3. Go to **Features** → **In-App Purchases**
4. Click **+** to create a subscription group
5. Name it: "Bookshelf Scanner Pro"
6. Click **Create**

### 1.2 Create Subscription Product
1. In your subscription group, click **+** to add subscription
2. **Reference Name**: "Pro Monthly Subscription"
3. **Product ID**: `com.bookshelfscanner.pro.monthly` (must be unique, use your bundle ID)
4. **Subscription Duration**: 1 Month
5. **Price**: Set your price (e.g., $4.99/month)
6. Click **Create**

### 1.3 Configure Subscription Details
1. **Display Name**: "Pro Monthly"
2. **Description**: "Unlimited book scans per month. Access to all premium features."
3. Add **Subscription Information**:
   - Benefits: "Unlimited scans", "Priority support", "All features"
4. Upload **Subscription Image** (1024x1024px)
5. Click **Save**

### 1.4 Submit for Review
1. Go to **App Information** → **In-App Purchases**
2. Make sure subscription shows "Ready to Submit"
3. Submit for review (can be done with app submission)

## Step 2: Install Required Packages

Run these commands in your project:

```bash
npm install react-native-iap
npm install @react-native-async-storage/async-storage
```

## Step 3: Configure App

### 3.1 Update app.config.js
Add your subscription product ID:

```javascript
extra: {
  // ... existing config
  IAP_PRODUCT_ID: 'com.bookshelfscanner.pro.monthly',
}
```

### 3.2 iOS Capabilities
1. Open Xcode
2. Select your project → **Signing & Capabilities**
3. Click **+ Capability**
4. Add **In-App Purchase**

## Step 4: Test Setup

### 4.1 Create Sandbox Test Account
1. App Store Connect → **Users and Access** → **Sandbox Testers**
2. Click **+** to create test account
3. Use a real email (you'll receive verification)
4. Create password

### 4.2 Test on Device
1. Sign out of App Store on test device
2. Run app in development
3. When prompted, sign in with sandbox test account
4. Test subscription purchase

## Important Notes

- **Product ID must match exactly** between App Store Connect and code
- **Test in Sandbox** before going live
- **Subscription auto-renews** unless cancelled
- **Apple takes 30%** (15% after year 1)
- **Receipt validation** happens server-side for security

## Next Steps

After completing Step 1, I'll help you:
1. Install packages
2. Create IAP service code
3. Integrate with subscription system
4. Add UI for subscription management
5. Test the flow






