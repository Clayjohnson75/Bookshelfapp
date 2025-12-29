/**
 * Apple In-App Purchase Service
 * 
 * Handles Apple IAP subscription purchases and validation
 */

import * as InAppPurchase from 'react-native-iap';
import { Platform, Alert } from 'react-native';
import { supabase } from '../lib/supabaseClient';

// Product ID - Update this to match your App Store Connect product ID
const PRO_SUBSCRIPTION_PRODUCT_ID = 'com.bookshelfscanner.pro.monthly'; // TODO: Update this!

let purchaseUpdateSubscription: any = null;
let purchaseErrorSubscription: any = null;

/**
 * Initialize IAP service and load products
 */
export async function initializeIAP(): Promise<InAppPurchase.Product[]> {
  try {
    if (Platform.OS !== 'ios') {
      console.warn('IAP only available on iOS');
      return [];
    }

    // Initialize connection
    await InAppPurchase.initConnection();
    
    // Get available products
    const products = await InAppPurchase.getProducts({ skus: [PRO_SUBSCRIPTION_PRODUCT_ID] });
    
    console.log('Available IAP products:', products);
    
    // Set up purchase listeners
    setupPurchaseListeners();
    
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

    // Request purchase
    await InAppPurchase.requestPurchase(PRO_SUBSCRIPTION_PRODUCT_ID, false);
  } catch (error: any) {
    console.error('Error requesting purchase:', error);
    Alert.alert('Error', error.message || 'Failed to start purchase');
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


