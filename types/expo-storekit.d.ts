declare module 'expo-storekit' {
  export interface Transaction {
    transactionIdentifier?: string;
    [key: string]: unknown;
  }

  export interface Product {
    productId: string;
    localizedTitle: string;
    localizedDescription: string;
    localizedPrice: string;
    priceCurrencyCode?: string;
    subscriptionPeriod?: { unit: string; value: number };
    [key: string]: unknown;
  }

  export interface PurchaseResponse {
    response?: { transactionIdentifier: string };
    error?: { localizedDescription?: string };
  }

  export interface SubscriptionStatus {
    state?: string;
    expiresDate?: string;
    [key: string]: unknown;
  }

  export function initializeStoreKit(): Promise<void>;
  export function getProducts(productIds: string[]): Promise<Product[]>;
  export function purchaseItem(productId: string): Promise<PurchaseResponse>;
  export function restorePurchases(): Promise<void>;
  export function getSubscriptionStatus(productId: string): Promise<SubscriptionStatus | null>;
  export function addTransactionListener(callback: (event: { transactions: Transaction[] }) => void): { remove: () => void };
}
