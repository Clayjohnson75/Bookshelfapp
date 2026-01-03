/**
 * Apple In-App Purchase Service
 * 
 * Handles Apple IAP subscription purchases and validation
 */

import { Platform, Alert } from 'react-native';
import Constants from 'expo-constants';
import { supabase } from '../lib/supabaseClient';

// Check if we're in Expo Go (react-native-iap won't work)
const isExpoGo = Constants.executionEnvironment === 'storeClient';

// Conditionally import react-native-iap (only works in dev builds, not Expo Go)
let InAppPurchase: any = null;
try {
  if (!isExpoGo) {
    InAppPurchase = require('react-native-iap');
  }
} catch (e) {
  console.warn('react-native-iap not available (likely in Expo Go)');
}

// Product ID - Update this to match your App Store Connect product ID
// IMPORTANT: This must match EXACTLY what you set in App Store Connect
const PRO_SUBSCRIPTION_PRODUCT_ID = 'com.bookshelfscanner.pro.monthly';

let purchaseUpdateSubscription: any = null;
let purchaseErrorSubscription: any = null;

/**
 * Initialize IAP service and load products
 */
export async function initializeIAP(): Promise<any[]> {
  try {
    if (Platform.OS !== 'ios') {
      console.warn('IAP only available on iOS');
      return [];
    }

    // Check if react-native-iap is available (not in Expo Go)
    if (!InAppPurchase || isExpoGo) {
      console.warn('IAP not available in Expo Go. Use a development build to test IAP features.');
      return [];
    }

    // Initialize connection (only if not already initialized)
    try {
      await InAppPurchase.initConnection();
    } catch (error: any) {
      // If already initialized, this will throw - that's OK
      if (!error.message?.includes('already')) {
        console.warn('IAP connection may already be initialized:', error);
      }
    }
    
    // Get available products
    const products = await InAppPurchase.getProducts({ skus: [PRO_SUBSCRIPTION_PRODUCT_ID] });
    
    console.log(`[IAP] Loaded ${products.length} products for Product ID: ${PRO_SUBSCRIPTION_PRODUCT_ID}`);
    if (products.length > 0) {
      console.log('[IAP] Product details:', {
        id: products[0].productId,
        title: products[0].title,
        price: products[0].localizedPrice,
      });
    } else {
      console.warn(`[IAP] ⚠️ No products found for Product ID: ${PRO_SUBSCRIPTION_PRODUCT_ID}`);
      console.warn('[IAP] This usually means:');
      console.warn('[IAP] 1. Product ID doesn\'t match App Store Connect');
      console.warn('[IAP] 2. Subscription not created/approved in App Store Connect');
      console.warn('[IAP] 3. Subscription not submitted for review');
    }
    
    // Set up purchase listeners (only once)
    if (!purchaseUpdateSubscription && !purchaseErrorSubscription) {
      setupPurchaseListeners();
    }
    
    return products;
  } catch (error) {
    console.error('Error initializing IAP:', error);
    return [];
  }
}

/**
 * Set up listeners for purchase updates
 */
function setupPurchaseListeners() {
  // Listen for successful purchases
  purchaseUpdateSubscription = InAppPurchase.purchaseUpdatedListener(
    async (purchase: InAppPurchase.Purchase) => {
      console.log('Purchase successful:', purchase);
      
      try {
        // Validate receipt with your server
        const isValid = await validateReceipt(purchase);
        
        if (isValid) {
          // Update subscription in Supabase
          await updateSubscriptionStatus(purchase);
          
          // Acknowledge purchase to Apple
          await InAppPurchase.finishTransaction(purchase);
          
          Alert.alert('Success', 'Your Pro subscription is now active!');
        } else {
          Alert.alert('Error', 'Failed to validate subscription. Please contact support.');
        }
      } catch (error) {
        console.error('Error processing purchase:', error);
        Alert.alert('Error', 'Failed to process subscription. Please contact support.');
      }
    }
  );

  // Listen for purchase errors
  purchaseErrorSubscription = InAppPurchase.purchaseErrorListener(
    (error: InAppPurchase.PurchaseError) => {
      console.error('Purchase error:', error);
      
      if (error.code === 'E_USER_CANCELLED') {
        // User cancelled - don't show error
        return;
      }
      
      Alert.alert('Purchase Failed', error.message || 'An error occurred during purchase');
    }
  );
}

/**
 * Purchase Pro subscription
 */
export async function purchaseProSubscription(): Promise<void> {
  try {
    if (Platform.OS !== 'ios') {
      Alert.alert('Not Available', 'In-App Purchases are only available on iOS');
      return;
    }

    // Check if react-native-iap is available (not in Expo Go)
    if (!InAppPurchase || isExpoGo) {
      Alert.alert(
        'Not Available in Expo Go',
        'In-App Purchases require a development build. Please build the app with EAS Build to test subscription features.'
      );
      return;
    }

    // Ensure IAP is initialized and products are loaded
    const products = await initializeIAP();
    
    if (products.length === 0) {
      Alert.alert(
        'Product Not Available',
        'The subscription product could not be loaded. Please check:\n\n' +
        '1. Your internet connection\n' +
        '2. The product ID matches App Store Connect\n' +
        '3. The subscription is approved in App Store Connect\n\n' +
        `Expected Product ID: ${PRO_SUBSCRIPTION_PRODUCT_ID}`
      );
      return;
    }

    // Verify the product exists
    const product = products.find(p => p.productId === PRO_SUBSCRIPTION_PRODUCT_ID);
    if (!product) {
      Alert.alert(
        'Product Not Found',
        `The subscription product "${PRO_SUBSCRIPTION_PRODUCT_ID}" was not found.\n\n` +
        'Please verify the product ID matches what you set in App Store Connect.'
      );
      return;
    }

    console.log('Requesting purchase for product:', product.productId, product.title);
    
    // Request purchase
    await InAppPurchase.requestPurchase(PRO_SUBSCRIPTION_PRODUCT_ID, false);
  } catch (error: any) {
    console.error('Error requesting purchase:', error);
    
    // Provide more helpful error messages
    if (error.code === 'E_ITEM_UNAVAILABLE') {
      Alert.alert(
        'Product Unavailable',
        'The subscription product is not available. Please check App Store Connect to ensure:\n\n' +
        '1. The subscription is created and approved\n' +
        '2. The Product ID matches: ' + PRO_SUBSCRIPTION_PRODUCT_ID + '\n' +
        '3. The subscription is submitted for review'
      );
    } else if (error.message?.includes('configuration')) {
      Alert.alert(
        'Configuration Error',
        'Purchase request configuration is missing. This usually means:\n\n' +
        '1. Products haven\'t been loaded yet\n' +
        '2. The product ID doesn\'t exist in App Store Connect\n' +
        '3. The subscription needs to be set up in App Store Connect\n\n' +
        `Expected Product ID: ${PRO_SUBSCRIPTION_PRODUCT_ID}`
      );
    } else {
      Alert.alert('Error', error.message || 'Failed to start purchase');
    }
  }
}

/**
 * Restore previous purchases (for users who reinstalled app)
 */
export async function restorePurchases(): Promise<boolean> {
  try {
    if (Platform.OS !== 'ios') {
      return false;
    }

    // Check if react-native-iap is available (not in Expo Go)
    if (!InAppPurchase || isExpoGo) {
      Alert.alert(
        'Not Available in Expo Go',
        'In-App Purchases require a development build. Please build the app with EAS Build to test subscription features.'
      );
      return false;
    }

    const purchases = await InAppPurchase.getAvailablePurchases();
    
    if (purchases.length === 0) {
      Alert.alert('No Purchases', 'No previous purchases found to restore');
      return false;
    }

    // Find Pro subscription
    const proPurchase = purchases.find(
      p => p.productId === PRO_SUBSCRIPTION_PRODUCT_ID
    );

    if (proPurchase) {
      // Validate and update subscription
      const isValid = await validateReceipt(proPurchase);
      if (isValid) {
        await updateSubscriptionStatus(proPurchase);
        Alert.alert('Success', 'Your Pro subscription has been restored!');
        return true;
      }
    }

    Alert.alert('No Subscription', 'No active Pro subscription found');
    return false;
  } catch (error: any) {
    console.error('Error restoring purchases:', error);
    Alert.alert('Error', error.message || 'Failed to restore purchases');
    return false;
  }
}

/**
 * Validate receipt with your server
 * For production, you should validate on your backend
 */
async function validateReceipt(purchase: InAppPurchase.Purchase): Promise<boolean> {
  try {
    // In production, send receipt to your backend for validation
    // For now, we'll do basic validation
    
    if (!purchase.transactionReceipt) {
      return false;
    }

    // TODO: Send receipt to your API endpoint for server-side validation
    // This is important for security - never trust client-side validation alone
    
    // For now, basic check
    return purchase.productId === PRO_SUBSCRIPTION_PRODUCT_ID;
  } catch (error) {
    console.error('Error validating receipt:', error);
    return false;
  }
}

/**
 * Update subscription status in Supabase
 */
async function updateSubscriptionStatus(purchase: InAppPurchase.Purchase): Promise<void> {
  if (!supabase) {
    throw new Error('Supabase not available');
  }

  try {
    // Get current user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      throw new Error('User not authenticated');
    }

    // Calculate subscription end date (1 month from now)
    const subscriptionEndsAt = new Date();
    subscriptionEndsAt.setMonth(subscriptionEndsAt.getMonth() + 1);

    // Update profile with subscription info
    const { error } = await supabase
      .from('profiles')
      .update({
        subscription_tier: 'pro',
        subscription_status: 'active',
        subscription_started_at: new Date().toISOString(),
        subscription_ends_at: subscriptionEndsAt.toISOString(),
        apple_product_id: purchase.productId,
        apple_transaction_id: purchase.transactionId || purchase.transactionReceipt || null,
        apple_original_transaction_id: purchase.originalTransactionIdentifierIOS || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (error) {
      console.error('Error updating subscription:', error);
      throw error;
    }

    console.log('Subscription updated successfully');
  } catch (error) {
    console.error('Error updating subscription status:', error);
    throw error;
  }
}

/**
 * Check current subscription status
 */
export async function checkSubscriptionStatus(): Promise<'free' | 'pro'> {
  if (!supabase) {
    return 'free';
  }

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return 'free';
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('subscription_tier, subscription_status, subscription_ends_at')
      .eq('id', user.id)
      .single();

    if (error || !data) {
      return 'free';
    }

    // Check if subscription is still active
    if (data.subscription_tier === 'pro') {
      if (data.subscription_ends_at) {
        const endsAt = new Date(data.subscription_ends_at);
        if (endsAt > new Date()) {
          return 'pro';
        }
      } else {
        // No end date means active subscription
        return 'pro';
      }
    }

    return 'free';
  } catch (error) {
    console.error('Error checking subscription:', error);
    return 'free';
  }
}

/**
 * Clean up IAP listeners
 */
export function cleanupIAP() {
  if (purchaseUpdateSubscription) {
    purchaseUpdateSubscription.remove();
    purchaseUpdateSubscription = null;
  }
  if (purchaseErrorSubscription) {
    purchaseErrorSubscription.remove();
    purchaseErrorSubscription = null;
  }
  
  if (Platform.OS === 'ios') {
    InAppPurchase.endConnection();
  }
}


