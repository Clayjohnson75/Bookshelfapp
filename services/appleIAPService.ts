/**
 * Apple In-App Purchase Service
 * Handles subscription purchases, restoration, and Supabase sync
 */

import { supabase } from '../lib/supabaseClient';
import { Platform, Alert } from 'react-native';
import Constants from 'expo-constants';

// Product ID - Update this to match your App Store Connect product
const PRODUCT_ID = 'com.bookshelfscanner.pro.monthly';

// Check if we're in Expo Go (IAP doesn't work in Expo Go)
const isExpoGo = Constants.appOwnership === 'expo';

// Lazy load react-native-iap to avoid loading in Expo Go
let iapModule: any = null;
async function getIAPModule() {
  if (isExpoGo) {
    return null;
  }
  if (!iapModule) {
    try {
      const module = await import('react-native-iap');
      // react-native-iap v14 exports methods directly on default export
      // Try different import patterns to find the correct one
      iapModule = module.default || module;
      
      // If default is an object, check if it has the methods
      if (iapModule && typeof iapModule === 'object' && !iapModule.initConnection) {
        // Try accessing methods directly if they're on the module
        if (module.initConnection) {
          iapModule = module;
        }
      }
      
      console.log('📦 IAP module loaded:', {
        hasDefault: !!module.default,
        defaultType: typeof module.default,
        defaultKeys: module.default ? Object.keys(module.default).slice(0, 10) : [],
        moduleKeys: Object.keys(module).slice(0, 10),
        iapModuleKeys: iapModule ? Object.keys(iapModule).slice(0, 10) : []
      });
      
      // Verify critical methods exist
      if (!iapModule) {
        console.error('❌ IAP module is null or undefined');
        return null;
      }
      
      if (typeof iapModule.initConnection !== 'function') {
        console.error('❌ IAP module missing initConnection method');
        console.log('Available on iapModule:', Object.keys(iapModule).slice(0, 20));
        return null;
      }
      if (typeof iapModule.purchaseUpdatedListener !== 'function') {
        console.error('❌ IAP module missing purchaseUpdatedListener method');
        console.log('Available methods:', Object.keys(iapModule).slice(0, 20));
        // Try using module directly if it has the method
        if (typeof module.purchaseUpdatedListener === 'function') {
          console.log('✅ Found purchaseUpdatedListener on module, switching to module');
          iapModule = module;
        } else {
          return null;
        }
      }
      if (typeof iapModule.requestPurchase !== 'function') {
        console.error('❌ IAP module missing requestPurchase method');
        console.log('Available methods:', Object.keys(iapModule).slice(0, 20));
        // Try using module directly if it has the method
        if (typeof module.requestPurchase === 'function') {
          console.log('✅ Found requestPurchase on module, switching to module');
          iapModule = module;
        } else {
          return null;
        }
      }
      
      console.log('✅ IAP module verified - all required methods exist');
    } catch (error) {
      console.error('Failed to load react-native-iap:', error);
      return null;
    }
  }
  return iapModule;
}

// Type definitions for IAP
type Product = {
  productId: string;
  title: string;
  localizedPrice: string;
  description?: string;
};

type Purchase = {
  productId: string;
  transactionId?: string;
  transactionReceipt?: string;
  originalTransactionIdentifierIOS?: string;
};

// Track if IAP is initialized
let isIAPInitialized = false;

export interface IAPProduct {
  productId: string;
  title: string;
  localizedPrice: string;
  description?: string;
}

/**
 * Initialize IAP and load available products
 */
export async function initializeIAP(): Promise<IAPProduct[]> {
  if (isExpoGo) {
    console.warn('⚠️ IAP not available in Expo Go. Use a development build or TestFlight.');
    return [];
  }

  if (Platform.OS !== 'ios') {
    console.warn('⚠️ IAP only supported on iOS');
    return [];
  }

  try {
    const iap = await getIAPModule();
    if (!iap) {
      return [];
    }

    // Initialize react-native-iap connection
    if (!isIAPInitialized) {
      await iap.initConnection();
      isIAPInitialized = true;
    }

    // Get products
    const products: Product[] = await iap.getProducts({ skus: [PRODUCT_ID] });

    if (products.length === 0) {
      console.warn('⚠️ No products found. Make sure the product is configured in App Store Connect.');
      return [];
    }

    return products.map(product => ({
      productId: product.productId,
      title: product.title,
      localizedPrice: product.localizedPrice,
      description: product.description,
    }));
  } catch (error: any) {
    console.error('Error initializing IAP:', error);
    throw new Error(error?.message || 'Failed to load subscription products');
  }
}

/**
 * Purchase Pro subscription
 */
export async function purchaseProSubscription(): Promise<void> {
  if (isExpoGo) {
    Alert.alert(
      'Not Available',
      'In-app purchases are not available in Expo Go. Please use a development build or TestFlight to test subscriptions.',
    );
    throw new Error('IAP not available in Expo Go');
  }

  if (Platform.OS !== 'ios') {
    Alert.alert('Error', 'In-app purchases are only available on iOS');
    throw new Error('IAP only supported on iOS');
  }

  try {
    console.log('🔍 Getting IAP module...');
    const iap = await getIAPModule();
    if (!iap) {
      console.error('❌ IAP module is null');
      Alert.alert('Purchase Error', 'In-app purchase system is not available. Please make sure you\'re using a development build or TestFlight.');
      throw new Error('IAP module not available');
    }

    console.log('✅ IAP module loaded. Available methods:', Object.keys(iap).slice(0, 20));
    console.log('🔍 Checking specific methods:');
    console.log('  - initConnection:', typeof iap.initConnection);
    console.log('  - purchaseUpdatedListener:', typeof iap.purchaseUpdatedListener);
    console.log('  - purchaseErrorListener:', typeof iap.purchaseErrorListener);
    console.log('  - requestPurchase:', typeof iap.requestPurchase);
    console.log('  - getProducts:', typeof iap.getProducts);
    console.log('  - finishTransaction:', typeof iap.finishTransaction);

    // Initialize if not already done
    if (!isIAPInitialized) {
      console.log('🔌 Initializing IAP connection...');
      if (typeof iap.initConnection !== 'function') {
        console.error('❌ initConnection is not a function');
        Alert.alert('Purchase Error', 'In-app purchase system is not properly initialized.');
        throw new Error('initConnection is not a function');
      }
      await iap.initConnection();
      isIAPInitialized = true;
      console.log('✅ IAP connection initialized');
    }

    // First, verify the product exists
    const products: Product[] = await iap.getProducts({ skus: [PRODUCT_ID] });
    if (products.length === 0) {
      Alert.alert(
        'Product Not Available',
        'The subscription product is not available. Please make sure it\'s configured in App Store Connect.',
      );
      throw new Error('Product not found');
    }

    // Verify IAP methods exist before using them
    if (typeof iap.purchaseUpdatedListener !== 'function') {
      console.error('❌ purchaseUpdatedListener is not a function');
      console.log('IAP module methods:', Object.keys(iap));
      Alert.alert('Purchase Error', 'In-app purchase system is not properly initialized. Please restart the app.');
      throw new Error('purchaseUpdatedListener is not a function');
    }
    
    if (typeof iap.purchaseErrorListener !== 'function') {
      console.error('❌ purchaseErrorListener is not a function');
      Alert.alert('Purchase Error', 'In-app purchase system is not properly initialized. Please restart the app.');
      throw new Error('purchaseErrorListener is not a function');
    }
    
    if (typeof iap.requestPurchase !== 'function') {
      console.error('❌ requestPurchase is not a function');
      Alert.alert('Purchase Error', 'In-app purchase system is not properly initialized. Please restart the app.');
      throw new Error('requestPurchase is not a function');
    }

    // Set up purchase listener before making purchase
    let purchaseResolve: ((purchase: Purchase) => void) | null = null;
    let purchaseReject: ((error: Error) => void) | null = null;

    const purchasePromise = new Promise<Purchase>((resolve, reject) => {
      purchaseResolve = resolve;
      purchaseReject = reject;
    });

    console.log('✅ Setting up purchase listeners...');
    const purchaseUpdateSubscription = iap.purchaseUpdatedListener(async (purchase: Purchase) => {
      if (purchase.productId === PRODUCT_ID) {
        // Purchase successful - update Supabase
        const transactionId = purchase.transactionId || purchase.transactionReceipt;
        const originalTransactionId = purchase.originalTransactionIdentifierIOS || transactionId;
        
        console.log('✅ Purchase successful:', {
          transactionId,
          originalTransactionId,
          productId: PRODUCT_ID,
        });

        try {
          // Update Supabase
          await updateSubscriptionInSupabase({
            transactionId: transactionId || '',
            originalTransactionId: originalTransactionId || transactionId || '',
            productId: PRODUCT_ID,
          });

          // Finish the transaction
          await iap.finishTransaction({ purchase, isConsumable: false });

          // Resolve the promise
          if (purchaseResolve) {
            purchaseResolve(purchase);
          }

          Alert.alert('Success!', 'Your Pro subscription is now active. Enjoy unlimited scans!');
        } catch (updateError: any) {
          console.error('Error updating subscription:', updateError);
          // Still finish transaction even if Supabase update fails
          await iap.finishTransaction({ purchase, isConsumable: false });
          
          // Resolve anyway since purchase succeeded
          if (purchaseResolve) {
            purchaseResolve(purchase);
          }
        }
      }
    });

    const purchaseErrorSubscription = iap.purchaseErrorListener((error) => {
      console.error('Purchase error:', error);
      
      if (purchaseReject) {
        if (error.code === 'E_USER_CANCELLED' || error.userCancelled) {
          purchaseReject(new Error('User cancelled purchase'));
        } else {
          purchaseReject(new Error(error.message || 'Purchase failed'));
        }
      }
      
      if (error.code !== 'E_USER_CANCELLED' && !error.userCancelled) {
        Alert.alert('Purchase Error', error.message || 'Failed to complete purchase. Please try again.');
      }
    });

    // Attempt purchase
    try {
      console.log('🛒 Requesting purchase for product:', PRODUCT_ID);
      console.log('🔍 Final check - requestPurchase type:', typeof iap.requestPurchase);
      
      if (typeof iap.requestPurchase !== 'function') {
        console.error('❌ CRITICAL: requestPurchase is not a function!');
        console.error('IAP object:', iap);
        console.error('All IAP methods:', Object.keys(iap));
        throw new Error('requestPurchase method is not available on IAP module');
      }
      
      await iap.requestPurchase({ sku: PRODUCT_ID });
      
      // Wait for purchase to complete (listeners will resolve/reject)
      await purchasePromise;
      
      // Clean up listeners
      purchaseUpdateSubscription.remove();
      purchaseErrorSubscription.remove();
    } catch (purchaseError: any) {
      // Clean up listeners
      purchaseUpdateSubscription.remove();
      purchaseErrorSubscription.remove();
      
      // Handle purchase errors
      if (purchaseError.code === 'E_USER_CANCELLED' || purchaseError.userCancelled || purchaseError.message === 'User cancelled purchase') {
        // User cancelled - don't show error
        throw new Error('User cancelled purchase');
      }
      
      const errorMessage = purchaseError.message || 'Purchase failed';
      if (!purchaseError.message?.includes('User cancelled')) {
        Alert.alert('Purchase Failed', errorMessage);
      }
      throw new Error(errorMessage);
    }
  } catch (error: any) {
    console.error('Purchase error:', error);
    
    // Don't show alert if user cancelled
    if (error?.message === 'User cancelled purchase' || error?.code === 'E_USER_CANCELLED') {
      throw error;
    }
    
    // Show error alert for other errors
    if (!error?.message?.includes('User cancelled') && !error?.userCancelled) {
      Alert.alert('Purchase Error', error?.message || 'Failed to complete purchase. Please try again.');
    }
    
    throw error;
  }
}

/**
 * Restore previous purchases
 */
export async function restorePurchases(): Promise<boolean> {
  if (isExpoGo) {
    Alert.alert(
      'Not Available',
      'In-app purchases are not available in Expo Go. Please use a development build or TestFlight.',
    );
    return false;
  }

  if (Platform.OS !== 'ios') {
    return false;
  }

  try {
    const iap = await getIAPModule();
    if (!iap) {
      return false;
    }

    // Initialize if not already done
    if (!isIAPInitialized) {
      await iap.initConnection();
      isIAPInitialized = true;
    }

    // Restore purchases
    const purchases = await iap.restorePurchases();

    // Check if user has active subscription
    if (purchases && purchases.length > 0) {
      // Find the subscription purchase
      const subscriptionPurchase = purchases.find(p => p.productId === PRODUCT_ID);
      
      if (subscriptionPurchase) {
        // User has active subscription - update Supabase
        const transactionId = subscriptionPurchase.transactionId || subscriptionPurchase.transactionReceipt;
        const originalTransactionId = subscriptionPurchase.originalTransactionIdentifierIOS || transactionId;
        
        await updateSubscriptionInSupabase({
          transactionId: transactionId || '',
          originalTransactionId: originalTransactionId || transactionId || '',
          productId: PRODUCT_ID,
        });

        return true;
      }
    }

    return false;
  } catch (error: any) {
    console.error('Error restoring purchases:', error);
    Alert.alert('Error', 'Failed to restore purchases. Please try again.');
    return false;
  }
}

/**
 * Check current subscription status
 */
export async function checkSubscriptionStatus(): Promise<'free' | 'pro'> {
  if (isExpoGo || Platform.OS !== 'ios') {
    // Fallback to Supabase check
    return await checkSubscriptionFromSupabase();
  }

  try {
    const iap = await getIAPModule();
    if (!iap) {
      // Fallback to Supabase check
      return await checkSubscriptionFromSupabase();
    }

    // Initialize if not already done
    if (!isIAPInitialized) {
      await iap.initConnection();
      isIAPInitialized = true;
    }

    // Get available purchases (active subscriptions)
    const purchases: Purchase[] = await iap.getAvailablePurchases();
    
    if (purchases && purchases.length > 0) {
      const subscriptionPurchase = purchases.find(p => p.productId === PRODUCT_ID);
      
      // Check if subscription is active
      if (subscriptionPurchase && subscriptionPurchase.transactionId) {
        // Also update Supabase to ensure sync
        const transactionId = subscriptionPurchase.transactionId || subscriptionPurchase.transactionReceipt;
        const originalTransactionId = subscriptionPurchase.originalTransactionIdentifierIOS || transactionId;
        
        await updateSubscriptionInSupabase({
          transactionId: transactionId || '',
          originalTransactionId: originalTransactionId || transactionId || '',
          productId: PRODUCT_ID,
        });

        return 'pro';
      }
    }

    // Check Supabase as fallback
    return await checkSubscriptionFromSupabase();
  } catch (error) {
    console.error('Error checking subscription status:', error);
    // Fallback to Supabase
    return await checkSubscriptionFromSupabase();
  }
}

/**
 * Update subscription in Supabase after successful purchase
 */
async function updateSubscriptionInSupabase({
  transactionId,
  originalTransactionId,
  productId,
}: {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
}): Promise<void> {
  if (!supabase) {
    console.error('❌ Supabase not available');
    throw new Error('Database not available');
  }

  try {
    // Get current user
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    
    if (userError || !user) {
      console.error('❌ No authenticated user:', userError);
      throw new Error('User not authenticated');
    }

    // Calculate subscription end date (1 month from now for monthly subscription)
    const subscriptionEndsAt = new Date();
    subscriptionEndsAt.setMonth(subscriptionEndsAt.getMonth() + 1);

    // Update profile with subscription info
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        subscription_tier: 'pro',
        subscription_status: 'active',
        subscription_started_at: new Date().toISOString(),
        subscription_ends_at: subscriptionEndsAt.toISOString(),
        apple_transaction_id: transactionId,
        apple_original_transaction_id: originalTransactionId,
        apple_product_id: productId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('❌ Error updating subscription in Supabase:', updateError);
      throw new Error('Failed to update subscription status');
    }

    console.log('✅ Subscription updated in Supabase:', {
      userId: user.id,
      tier: 'pro',
      transactionId,
    });

    // Also validate receipt server-side for security
    try {
      await validateReceiptServerSide(transactionId, originalTransactionId);
    } catch (validationError) {
      console.warn('⚠️ Server-side receipt validation failed (non-critical):', validationError);
      // Don't throw - client update succeeded
    }
  } catch (error: any) {
    console.error('❌ Error updating subscription:', error);
    throw error;
  }
}

/**
 * Check subscription status from Supabase
 */
async function checkSubscriptionFromSupabase(): Promise<'free' | 'pro'> {
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

    // Check if subscription is active and not expired
    if (data.subscription_tier === 'pro' && data.subscription_status === 'active') {
      // Check if subscription hasn't expired
      if (data.subscription_ends_at) {
        const endsAt = new Date(data.subscription_ends_at);
        if (endsAt > new Date()) {
          return 'pro';
        }
      } else {
        // No end date means active
        return 'pro';
      }
    }

    return 'free';
  } catch (error) {
    console.error('Error checking subscription from Supabase:', error);
    return 'free';
  }
}

/**
 * Validate receipt server-side (calls API endpoint)
 */
async function validateReceiptServerSide(
  transactionId: string,
  originalTransactionId: string,
): Promise<void> {
  try {
    const apiBaseUrl = Constants.expoConfig?.extra?.EXPO_PUBLIC_API_BASE_URL || 
                       process.env.EXPO_PUBLIC_API_BASE_URL || 
                       'https://bookshelfscan.app';

    const response = await fetch(`${apiBaseUrl}/api/validate-apple-receipt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transactionId,
        originalTransactionId,
        productId: PRODUCT_ID,
      }),
    });

    if (!response.ok) {
      throw new Error(`Receipt validation failed: ${response.status}`);
    }

    const result = await response.json();
    
    if (!result.success) {
      throw new Error(result.error || 'Receipt validation failed');
    }

    console.log('✅ Receipt validated server-side');
  } catch (error: any) {
    console.error('Receipt validation error:', error);
    throw error;
  }
}
