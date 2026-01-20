/**
 * StoreKit Service for In-App Subscriptions
 * Handles Auto-Renewable Subscriptions using Expo StoreKit
 */

import * as StoreKit from 'expo-storekit';

// Product IDs - Update these to match your App Store Connect products
export const SUBSCRIPTION_PRODUCT_IDS = {
  MONTHLY: 'com.bookshelfscanner.pro.monthly.v2',
  // YEARLY: 'com.bookshelfscanner.pro.yearly', // Uncomment when you create yearly subscription
} as const;

export type SubscriptionProductId = typeof SUBSCRIPTION_PRODUCT_IDS[keyof typeof SUBSCRIPTION_PRODUCT_IDS];

export interface SubscriptionProduct {
  id: string;
  title: string;
  description: string;
  price: string;
  currencyCode: string;
  subscriptionPeriod?: {
    unit: 'day' | 'week' | 'month' | 'year';
    value: number;
  };
}

export interface PurchaseResult {
  success: boolean;
  transactionId?: string;
  error?: string;
}

/**
 * Initialize StoreKit (call this when app starts)
 */
export async function initializeStoreKit(): Promise<void> {
  try {
    await StoreKit.initializeStoreKit();
  } catch (error) {
    console.error('Error initializing StoreKit:', error);
  }
}

/**
 * Get available subscription products
 */
export async function getSubscriptionProducts(): Promise<SubscriptionProduct[]> {
  try {
    const productIds = Object.values(SUBSCRIPTION_PRODUCT_IDS);
    const products = await StoreKit.getProducts(productIds);
    
    return products.map(product => ({
      id: product.productId,
      title: product.localizedTitle,
      description: product.localizedDescription,
      price: product.localizedPrice,
      currencyCode: product.priceCurrencyCode || 'USD',
      subscriptionPeriod: product.subscriptionPeriod,
    }));
  } catch (error) {
    console.error('Error fetching subscription products:', error);
    return [];
  }
}

/**
 * Purchase a subscription
 */
export async function purchaseSubscription(
  productId: SubscriptionProductId
): Promise<PurchaseResult> {
  try {
    const result = await StoreKit.purchaseItem(productId);
    
    if (result.response) {
      return {
        success: true,
        transactionId: result.response.transactionIdentifier,
      };
    } else if (result.error) {
      return {
        success: false,
        error: result.error.localizedDescription || 'Purchase failed',
      };
    }
    
    return {
      success: false,
      error: 'Unknown error during purchase',
    };
  } catch (error: any) {
    console.error('Error purchasing subscription:', error);
    return {
      success: false,
      error: error?.message || 'Purchase failed',
    };
  }
}

/**
 * Restore previous purchases
 */
export async function restorePurchases(): Promise<boolean> {
  try {
    await StoreKit.restorePurchases();
    return true;
  } catch (error) {
    console.error('Error restoring purchases:', error);
    return false;
  }
}

/**
 * Get current subscription status
 * This checks if the user has an active subscription
 */
export async function getSubscriptionStatus(): Promise<{
  isActive: boolean;
  productId?: string;
  expiresAt?: Date;
}> {
  try {
    const productIds = Object.values(SUBSCRIPTION_PRODUCT_IDS);
    
    // Check each product for active subscription
    for (const productId of productIds) {
      const status = await StoreKit.getSubscriptionStatus(productId);
      
      if (status && status.state === 'active') {
        return {
          isActive: true,
          productId,
          expiresAt: status.expiresDate ? new Date(status.expiresDate) : undefined,
        };
      }
    }
    
    return {
      isActive: false,
    };
  } catch (error) {
    console.error('Error checking subscription status:', error);
    return {
      isActive: false,
    };
  }
}

/**
 * Listen for subscription updates (transactions, renewals, cancellations)
 */
export function addSubscriptionListener(
  callback: (transaction: StoreKit.Transaction) => void
): () => void {
  const subscription = StoreKit.addTransactionListener(({ transactions }) => {
    transactions.forEach(transaction => {
      callback(transaction);
    });
  });
  
  return () => {
    subscription.remove();
  };
}



