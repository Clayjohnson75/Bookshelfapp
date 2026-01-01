# Implementation Guide: Biometric Auth, Password AutoFill, and Subscriptions

This guide explains how to properly implement the three features you requested.

## 📦 Step 1: Install Required Packages

Run this command in your terminal:

```bash
npm install expo-local-authentication expo-secure-store expo-storekit
```

Then rebuild your app:
```bash
npx expo prebuild --clean
eas build --platform ios --profile production
```

## 🔐 Step 2: Password AutoFill (Already Implemented!)

**Status: ✅ DONE**

I've already added the necessary `textContentType` props to your login and sign-up screens:

- **Login screen**: `textContentType="username"` and `textContentType="password"`
- **Sign-up screen**: `textContentType="emailAddress"` and `textContentType="newPassword"`

This enables iOS Password AutoFill automatically. Users will see the "Use Saved Password?" popup when they tap the password field.

### Optional: Associated Domains (For Web Credentials)

If you want AutoFill to work across your website and app, add this to `app.config.js`:

```javascript
ios: {
  associatedDomains: ["webcredentials:yourdomain.com"]
}
```

Then add an `apple-app-site-association` file to your website root.

---

## 👤 Step 3: Biometric Authentication (Face ID / Touch ID)

**Status: ✅ Code Created, Needs Integration**

### A) What's Already Done:

1. ✅ Created `services/biometricAuth.ts` - Complete biometric service
2. ✅ Added Face ID permission to `app.config.js`
3. ✅ Integrated biometric functions into `SimpleAuthContext.tsx`
4. ✅ Added biometric capabilities checking

### B) What You Need to Do:

#### 1. Add Biometric Login Button to Login Screen

Update `auth/AuthScreens.tsx` to show a Face ID/Touch ID button:

```typescript
import { useAuth } from './SimpleAuthContext';
import * as BiometricAuth from '../services/biometricAuth';

// In LoginScreen component:
const { signInWithBiometric, biometricCapabilities, isBiometricEnabled } = useAuth();
const [biometricEnabled, setBiometricEnabled] = useState(false);

useEffect(() => {
  checkBiometricStatus();
}, []);

const checkBiometricStatus = async () => {
  const enabled = await isBiometricEnabled();
  setBiometricEnabled(enabled);
};

const handleBiometricLogin = async () => {
  const success = await signInWithBiometric();
  if (success) {
    onAuthSuccess();
  }
};

// In your JSX, add this button (after the Sign In button):
{biometricCapabilities?.isAvailable && biometricEnabled && (
  <TouchableOpacity
    style={styles.biometricButton}
    onPress={handleBiometricLogin}
  >
    <Ionicons 
      name={biometricCapabilities.supportedTypes.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION) 
        ? 'face-recognition' 
        : 'finger-print'} 
      size={24} 
      color="#fff" 
    />
    <Text style={styles.biometricButtonText}>
      Sign in with {BiometricAuth.getBiometricTypeName(biometricCapabilities)}
    </Text>
  </TouchableOpacity>
)}
```

#### 2. Add "Remember Me" / "Enable Biometric" Option

Add a toggle or checkbox on the login screen:

```typescript
const [rememberMe, setRememberMe] = useState(false);

// After successful login:
if (rememberMe && biometricCapabilities?.isAvailable) {
  await enableBiometric(email, password);
}
```

#### 3. Add Biometric Settings Toggle

In your Settings modal (`components/SettingsModal.tsx`), add:

```typescript
const { biometricCapabilities, isBiometricEnabled, enableBiometric, disableBiometric } = useAuth();
const [biometricEnabled, setBiometricEnabled] = useState(false);

useEffect(() => {
  loadBiometricStatus();
}, []);

const loadBiometricStatus = async () => {
  const enabled = await isBiometricEnabled();
  setBiometricEnabled(enabled);
};

const toggleBiometric = async () => {
  if (biometricEnabled) {
    await disableBiometric();
    setBiometricEnabled(false);
    Alert.alert('Success', 'Biometric login disabled');
  } else {
    // Need email/password to enable
    // You could prompt user or use stored credentials
    Alert.alert('Enable Biometric', 'Please sign in again to enable biometric login');
  }
};

// In your settings UI:
{biometricCapabilities?.isAvailable && (
  <TouchableOpacity onPress={toggleBiometric}>
    <Text>Enable {BiometricAuth.getBiometricTypeName(biometricCapabilities)}</Text>
    <Switch value={biometricEnabled} onValueChange={toggleBiometric} />
  </TouchableOpacity>
)}
```

#### 4. Auto-Prompt for Biometric on App Start

In your `App.tsx` or main component, check for biometric login on app start:

```typescript
useEffect(() => {
  checkBiometricLogin();
}, []);

const checkBiometricLogin = async () => {
  const enabled = await isBiometricEnabled();
  if (enabled && !user) {
    // Show a prompt or automatically try biometric login
    const success = await signInWithBiometric();
    if (success) {
      // User is now signed in
    }
  }
};
```

---

## 💳 Step 4: In-App Subscriptions (StoreKit)

**Status: ✅ Code Created, Needs App Store Connect Setup**

### A) What's Already Done:

1. ✅ Created `services/storeKitService.ts` - Complete StoreKit service
2. ✅ Product IDs defined: `com.clayjohnson75.bookshelf-scanner.pro.monthly` and `.yearly`

### B) What You Need to Do:

#### 1. Set Up Products in App Store Connect

1. Go to [App Store Connect](https://appstoreconnect.apple.com)
2. Navigate to: **My Apps** → **Your App** → **In-App Purchases**
3. Click **+** to create a new subscription
4. Create two products:

   **Monthly Subscription:**
   - Product ID: `com.clayjohnson75.bookshelf-scanner.pro.monthly`
   - Type: Auto-Renewable Subscription
   - Subscription Group: Create "Pro Subscription" group
   - Duration: 1 Month
   - Price: Set your price (e.g., $4.99/month)

   **Yearly Subscription:**
   - Product ID: `com.clayjohnson75.bookshelf-scanner.pro.yearly`
   - Type: Auto-Renewable Subscription
   - Subscription Group: Same "Pro Subscription" group
   - Duration: 1 Year
   - Price: Set your price (e.g., $49.99/year)

5. Add subscription information (description, review notes)
6. Submit for review

#### 2. Initialize StoreKit on App Start

In your `App.tsx`:

```typescript
import { initializeStoreKit } from './services/storeKitService';

useEffect(() => {
  initializeStoreKit();
}, []);
```

#### 3. Update Your Upgrade Modal

In `components/UpgradeModal.tsx`, add purchase functionality:

```typescript
import { getSubscriptionProducts, purchaseSubscription, SUBSCRIPTION_PRODUCT_IDS } from '../services/storeKitService';

const [products, setProducts] = useState([]);
const [loading, setLoading] = useState(false);

useEffect(() => {
  loadProducts();
}, []);

const loadProducts = async () => {
  const prods = await getSubscriptionProducts();
  setProducts(prods);
};

const handlePurchase = async (productId: string) => {
  setLoading(true);
  const result = await purchaseSubscription(productId);
  setLoading(false);
  
  if (result.success) {
    Alert.alert('Success', 'Subscription activated!');
    // Update user's subscription status in Supabase
    // Refresh UI
  } else {
    Alert.alert('Error', result.error || 'Purchase failed');
  }
};

// In your UI:
{products.map(product => (
  <TouchableOpacity
    key={product.id}
    onPress={() => handlePurchase(product.id)}
    disabled={loading}
  >
    <Text>{product.title}</Text>
    <Text>{product.price}</Text>
  </TouchableOpacity>
))}
```

#### 4. Sync Subscription Status with Supabase

After a successful purchase, update the user's profile in Supabase:

```typescript
// In your purchase handler:
if (result.success) {
  // Update Supabase profile
  await supabase
    .from('profiles')
    .update({
      subscription_tier: 'pro',
      subscription_status: 'active',
      subscription_started_at: new Date().toISOString(),
    })
    .eq('id', user.uid);
}
```

#### 5. Check Subscription Status on App Start

```typescript
import { getSubscriptionStatus } from './services/storeKitService';

useEffect(() => {
  checkSubscription();
}, []);

const checkSubscription = async () => {
  const status = await getSubscriptionStatus();
  if (status.isActive) {
    // Update Supabase to reflect active subscription
    // Unlock Pro features
  }
};
```

#### 6. Listen for Subscription Updates

```typescript
import { addSubscriptionListener } from './services/storeKitService';

useEffect(() => {
  const unsubscribe = addSubscriptionListener((transaction) => {
    // Handle subscription renewal, cancellation, etc.
    if (transaction.transactionState === 'purchased') {
      // Update Supabase
    }
  });
  
  return () => unsubscribe();
}, []);
```

---

## 🧪 Testing

### Biometric Auth:
- Test on a real device (simulator doesn't support Face ID)
- Enable biometric in settings
- Sign out and try biometric login
- Test with Face ID disabled (should fall back to passcode)

### Password AutoFill:
- Save a password in iOS Settings → Passwords
- Open your app and tap the password field
- Should see "Use Saved Password?" popup

### Subscriptions:
- Use Sandbox test accounts in App Store Connect
- Test purchases in TestFlight or development builds
- Verify subscription status updates correctly

---

## 📝 Next Steps

1. **Install packages** (run the npm install command above)
2. **Add biometric UI** to login screen and settings
3. **Set up products** in App Store Connect
4. **Integrate StoreKit** into your upgrade modal
5. **Test thoroughly** before submitting to App Store

---

## ⚠️ Important Notes

- **Biometric**: Only works on real devices, not simulators
- **StoreKit**: Products must be created in App Store Connect first
- **Testing**: Use Sandbox accounts for testing subscriptions
- **Security**: Credentials are stored securely in Keychain via `expo-secure-store`

---

## 🆘 Troubleshooting

**Biometric not showing:**
- Check if device has Face ID/Touch ID enabled
- Verify `NSFaceIDUsageDescription` is in `app.config.js`
- Rebuild app after adding packages

**Password AutoFill not working:**
- Ensure `textContentType` is set correctly
- Check that fields are marked as `secureTextEntry={true}` for passwords
- Test on real device (simulator may not show AutoFill)

**Subscriptions not working:**
- Verify product IDs match App Store Connect exactly
- Check that products are approved/ready for sale
- Use Sandbox test accounts for testing
- Ensure StoreKit is initialized before making purchases



