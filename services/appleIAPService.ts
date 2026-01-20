/**
 * Apple In-App Purchase Service
 * Handles subscription purchases, restoration, and Supabase sync
 */

import { supabase } from '../lib/supabaseClient';
import { Platform, Alert } from 'react-native';
import Constants from 'expo-constants';

// Product ID - Update this to match your App Store Connect product
const PRODUCT_ID = 'com.bookshelfscanner.pro.monthly.v2';

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
      // react-native-iap v14 uses named exports
      // Import the module to get all exports
      let RNIap: any;
      try {
        // Try dynamic import first (gets named exports properly)
        const module = await import('react-native-iap');
        RNIap = module;
      } catch (importError) {
        // Fallback to require
        RNIap = require('react-native-iap');
      }
      
      // In v14, methods are named exports on the module itself
      // Check if methods exist as named exports first
      if (typeof RNIap.initConnection === 'function' || typeof RNIap.getProducts === 'function') {
        // Use named exports directly
        iapModule = RNIap;
      } else if (RNIap.default && typeof RNIap.default.initConnection === 'function') {
        // Fallback to default export
        iapModule = RNIap.default;
      } else {
        // Last resort: use RNIap as-is
        iapModule = RNIap;
      }
      
      console.log('📦 IAP module loaded:', {
        hasDefault: !!RNIap.default,
        defaultType: typeof RNIap.default,
        defaultKeys: RNIap.default ? Object.keys(RNIap.default).slice(0, 20) : [],
        rnIapKeys: Object.keys(RNIap).slice(0, 30),
        iapModuleKeys: iapModule ? Object.keys(iapModule).slice(0, 30) : [],
        productMethods: iapModule ? Object.keys(iapModule).filter(k => k.toLowerCase().includes('product')) : [],
        allFunctionKeys: iapModule ? Object.keys(iapModule).filter(k => typeof iapModule[k] === 'function').slice(0, 30) : []
      });
      
      // Verify critical methods exist
      if (!iapModule) {
        console.error('❌ IAP module is null or undefined');
        return null;
      }
      
      // Check each method and provide helpful error
      // Note: getProducts might be getProductsAsync in some versions
      const requiredMethods = ['initConnection', 'purchaseUpdatedListener', 'purchaseErrorListener', 'requestPurchase', 'finishTransaction'];
      const optionalMethods = ['getProducts', 'getProductsAsync'];
      const missingMethods: string[] = [];
      
      for (const method of requiredMethods) {
        if (typeof iapModule[method] !== 'function') {
          missingMethods.push(method);
        }
      }
      
      // Check if at least one product-getting method exists
      const hasGetProducts = optionalMethods.some(method => typeof iapModule[method] === 'function');
      if (!hasGetProducts) {
        missingMethods.push('getProducts or getProductsAsync');
      }
      
      if (missingMethods.length > 0) {
        console.error('❌ IAP module missing methods:', missingMethods);
        console.log('Available on iapModule:', Object.keys(iapModule).slice(0, 30));
        console.log('Available on RNIap:', Object.keys(RNIap).slice(0, 30));
        return null;
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

    // Get products - try different method names for v14 compatibility
    let products: Product[] = [];
    let getProductsMethod: any = null;
    
    // Try to find the getProducts method
    const methodNames = ['getProducts', 'getProductsAsync', 'getAvailablePurchases', 'getSubscriptions', 'getInAppProducts'];
    for (const methodName of methodNames) {
      if (typeof iap[methodName] === 'function') {
        getProductsMethod = iap[methodName];
        console.log(`✅ Found ${methodName} method in initializeIAP`);
        break;
      }
    }
    
    // Also check all function methods
    if (!getProductsMethod) {
      const allMethods = Object.keys(iap).filter(k => typeof iap[k] === 'function');
      const productMethod = allMethods.find(m => 
        m.toLowerCase().includes('product') || 
        m.toLowerCase().includes('subscription')
      );
      if (productMethod) {
        getProductsMethod = iap[productMethod];
        console.log(`✅ Found product method in initializeIAP: ${productMethod}`);
      }
    }
    
    if (!getProductsMethod) {
      console.error('❌ getProducts method not found in initializeIAP');
      console.error('Available function methods:', Object.keys(iap).filter(k => typeof iap[k] === 'function').slice(0, 30));
      throw new Error('getProducts method not available on IAP module');
    }
    
    // Try calling with different parameter formats
    try {
      products = await getProductsMethod({ skus: [PRODUCT_ID] });
    } catch (skuError: any) {
      try {
        products = await getProductsMethod({ productIds: [PRODUCT_ID] });
      } catch (productIdError: any) {
        products = await getProductsMethod([PRODUCT_ID]);
      }
    }

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
      try {
        await iap.initConnection();
        isIAPInitialized = true;
        console.log('✅ IAP connection initialized');
      } catch (initError: any) {
        console.error('❌ ERROR in initConnection():', initError);
        console.error('❌ initConnection error details:', {
          message: initError?.message,
          stack: initError?.stack,
          name: initError?.name,
          code: initError?.code
        });
        throw new Error(`initConnection failed: ${initError?.message || 'Unknown error'}`);
      }
    }

      // First, verify the product exists
      console.log('🔍 Getting products...');
      let products: Product[] = [];
      try {
        // Try different method names for v14 compatibility
        // In v14, methods might be: getProducts, getProductsAsync, getAvailablePurchases, etc.
        let getProductsMethod: any = null;
        const methodNames = ['getProducts', 'getProductsAsync', 'getAvailablePurchases', 'getSubscriptions', 'getInAppProducts'];
        
        for (const methodName of methodNames) {
          if (typeof iap[methodName] === 'function') {
            getProductsMethod = iap[methodName];
            console.log(`✅ Found ${methodName} method`);
            break;
          }
        }
        
        // Also check if it's a direct property with different casing
        if (!getProductsMethod) {
          const allMethods = Object.keys(iap).filter(k => typeof iap[k] === 'function');
          const productMethod = allMethods.find(m => 
            m.toLowerCase().includes('product') || 
            m.toLowerCase().includes('subscription') ||
            m.toLowerCase().includes('purchase')
          );
          if (productMethod) {
            getProductsMethod = iap[productMethod];
            console.log(`✅ Found product method: ${productMethod}`);
          }
        }
        
        if (!getProductsMethod) {
          console.error('❌ getProducts method not found');
          console.error('Available methods with "product" in name:', Object.keys(iap).filter(k => k.toLowerCase().includes('product')));
          console.error('All available function methods:', Object.keys(iap).filter(k => typeof iap[k] === 'function').slice(0, 30));
          console.error('All available methods:', Object.keys(iap).slice(0, 30));
          throw new Error('getProducts method not available on IAP module');
        }
        
        // Try calling with different parameter formats
        try {
          products = await getProductsMethod({ skus: [PRODUCT_ID] });
        } catch (skuError: any) {
          // Try with productIds instead of skus
          console.log('⚠️ getProducts with skus failed, trying productIds...');
          try {
            products = await getProductsMethod({ productIds: [PRODUCT_ID] });
          } catch (productIdError: any) {
            // Try with just array
            console.log('⚠️ getProducts with productIds failed, trying array...');
            products = await getProductsMethod([PRODUCT_ID]);
          }
        }
        console.log('✅ getProducts returned:', products.length, 'products');
    } catch (getProductsError: any) {
      console.error('❌ ERROR in getProducts():', getProductsError);
      console.error('❌ getProducts error details:', {
        message: getProductsError?.message,
        stack: getProductsError?.stack,
        name: getProductsError?.name,
        code: getProductsError?.code
      });
      throw new Error(`getProducts failed: ${getProductsError?.message || 'Unknown error'}`);
    }
    if (products.length === 0) {
      // Don't show error during app review - Apple tests in sandbox where products should be available
      // If products are empty, it might be a configuration issue or the product isn't in "Ready to Submit" state
      console.error('❌ No products found. This may be because:');
      console.error('  1. Product is not in "Ready to Submit" state in App Store Connect');
      console.error('  2. Product is not included in the app submission');
      console.error('  3. Product ID mismatch: expected', PRODUCT_ID);
      console.error('  4. Paid Apps Agreement not accepted');
      throw new Error('Product not available - ensure subscription is in "Ready to Submit" state and included in app submission');
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
    let purchaseTimeout: NodeJS.Timeout | null = null;

    // Helper to clear timeout when promise resolves/rejects
    const clearPurchaseTimeout = () => {
      if (purchaseTimeout) {
        clearTimeout(purchaseTimeout);
        purchaseTimeout = null;
      }
    };

    const purchasePromise = new Promise<Purchase>((resolve, reject) => {
      purchaseResolve = resolve;
      purchaseReject = reject;
      
      // Add timeout to prevent hanging forever (60 seconds)
      purchaseTimeout = setTimeout(() => {
        clearPurchaseTimeout();
        if (purchaseReject) {
          purchaseReject(new Error('Purchase timed out. Please try again or check your internet connection.'));
        }
      }, 60000); // 60 second timeout
    });

    console.log('✅ Setting up purchase listeners...');
    let purchaseUpdateSubscription: any;
    let purchaseErrorSubscription: any;
    
    try {
      if (typeof iap.purchaseUpdatedListener !== 'function') {
        throw new Error('purchaseUpdatedListener is not a function at call site');
      }
      purchaseUpdateSubscription = iap.purchaseUpdatedListener(async (purchase: Purchase) => {
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
          clearPurchaseTimeout();
          if (purchaseResolve) {
            purchaseResolve(purchase);
          }

          Alert.alert('Success!', 'Your Pro subscription is now active. Enjoy unlimited scans!');
        } catch (updateError: any) {
          console.error('Error updating subscription:', updateError);
          // Still finish transaction even if Supabase update fails
          await iap.finishTransaction({ purchase, isConsumable: false });
          
          // Resolve anyway since purchase succeeded
          clearPurchaseTimeout();
          if (purchaseResolve) {
            purchaseResolve(purchase);
          }
        }
      }
    });
    console.log('✅ purchaseUpdatedListener set up');
    } catch (listenerError: any) {
      console.error('❌ ERROR setting up purchaseUpdatedListener:', listenerError);
      console.error('❌ Listener error details:', {
        message: listenerError?.message,
        stack: listenerError?.stack,
        name: listenerError?.name
      });
      throw new Error(`purchaseUpdatedListener setup failed: ${listenerError?.message || 'Unknown error'}`);
    }

    try {
      if (typeof iap.purchaseErrorListener !== 'function') {
        throw new Error('purchaseErrorListener is not a function at call site');
      }
      purchaseErrorSubscription = iap.purchaseErrorListener((error) => {
      console.error('Purchase error:', error);
      
      clearPurchaseTimeout();
      if (purchaseReject) {
        if (error.code === 'E_USER_CANCELLED' || error.userCancelled) {
          purchaseReject(new Error('User cancelled purchase'));
        } else {
          purchaseReject(new Error(error.message || 'Purchase failed'));
        }
      }
      
      // Don't show alert here - let the outer catch handle it with better messaging
      // This prevents duplicate error messages
    });
    console.log('✅ purchaseErrorListener set up');
    } catch (errorListenerError: any) {
      console.error('❌ ERROR setting up purchaseErrorListener:', errorListenerError);
      console.error('❌ Error listener error details:', {
        message: errorListenerError?.message,
        stack: errorListenerError?.stack,
        name: errorListenerError?.name
      });
      throw new Error(`purchaseErrorListener setup failed: ${errorListenerError?.message || 'Unknown error'}`);
    }

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
      
      // react-native-iap v14 may use 'sku' or 'productId' parameter
      // Try both to be safe
      try {
        console.log('🛒 Calling requestPurchase with sku:', PRODUCT_ID);
        await iap.requestPurchase({ sku: PRODUCT_ID });
        console.log('✅ requestPurchase({ sku }) call completed');
      } catch (skuError: any) {
        console.error('❌ ERROR in requestPurchase({ sku }):', skuError);
        console.error('❌ requestPurchase sku error details:', {
          message: skuError?.message,
          stack: skuError?.stack,
          name: skuError?.name,
          code: skuError?.code
        });
        // If sku fails, try productId (v14 might use this)
        if (skuError?.message?.includes('sku') || skuError?.code === 'E_DEVELOPER_ERROR') {
          console.log('⚠️ requestPurchase with sku failed, trying productId...');
          try {
            await iap.requestPurchase({ productId: PRODUCT_ID });
            console.log('✅ requestPurchase({ productId }) call completed');
          } catch (productIdError: any) {
            console.error('❌ ERROR in requestPurchase({ productId }):', productIdError);
            console.error('❌ requestPurchase productId error details:', {
              message: productIdError?.message,
              stack: productIdError?.stack,
              name: productIdError?.name,
              code: productIdError?.code
            });
            throw productIdError;
          }
        } else {
          throw skuError;
        }
      }
      
      // Wait for purchase to complete (listeners will resolve/reject)
      await purchasePromise;
      
      // Clear timeout if we got here (should already be cleared, but just in case)
      clearPurchaseTimeout();
      
      // Clean up listeners
      purchaseUpdateSubscription.remove();
      purchaseErrorSubscription.remove();
    } catch (purchaseError: any) {
      // Clear timeout
      clearPurchaseTimeout();
      
      // Clean up listeners
      purchaseUpdateSubscription.remove();
      purchaseErrorSubscription.remove();
      
      // Handle purchase errors
      if (purchaseError.code === 'E_USER_CANCELLED' || purchaseError.userCancelled || purchaseError.message === 'User cancelled purchase') {
        // User cancelled - don't show error
        throw new Error('User cancelled purchase');
      }
      
      // Don't show alert here - let outer catch handle with user-friendly message
      // This prevents duplicate alerts and ensures consistent messaging
      throw purchaseError;
    }
  } catch (error: any) {
    console.error('Purchase error:', error);
    console.error('Purchase error details:', {
      message: error?.message,
      code: error?.code,
      name: error?.name,
      stack: error?.stack,
      userCancelled: error?.userCancelled,
      fullError: JSON.stringify(error, null, 2)
    });
    
    // Don't show alert if user cancelled
    if (error?.message === 'User cancelled purchase' || error?.code === 'E_USER_CANCELLED' || error?.userCancelled) {
      throw error;
    }
    
    // Show user-friendly error message (no technical details)
    let userMessage = 'Unable to complete purchase.';
    
    // Provide more helpful messages based on error type
    if (error?.message?.includes('timeout')) {
      userMessage = 'The purchase took too long. Please check your internet connection and try again.';
    } else if (error?.message?.includes('network') || error?.message?.includes('connection')) {
      userMessage = 'Network error. Please check your internet connection and try again.';
    } else if (error?.code === 'E_SERVICE_ERROR' || error?.code === 'E_NETWORK_ERROR') {
      userMessage = 'Unable to connect to the App Store. Please check your internet connection and try again.';
    } else if (error?.code === 'E_ITEM_UNAVAILABLE') {
      userMessage = 'This subscription is temporarily unavailable. Please try again later.';
    } else if (error?.message?.includes('not available')) {
      userMessage = 'In-app purchases are not available right now. Please try again later.';
    }
    
    Alert.alert(
      'Purchase Unavailable', 
      userMessage
    );
    
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
