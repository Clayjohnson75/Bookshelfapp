/**
 * Apple In-App Purchase Service
 * Handles subscription purchases, restoration, and Supabase sync
 */

import { supabase } from '../lib/supabase';
import { Platform, Alert } from 'react-native';
import Constants from 'expo-constants';
import { getScanAuthHeaders } from '../lib/authHeaders';

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
 
 console.log(' IAP module loaded:', {
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
 console.error(' IAP module is null or undefined');
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
 console.error(' IAP module missing methods:', missingMethods);
 console.log('Available on iapModule:', Object.keys(iapModule).slice(0, 30));
 console.log('Available on RNIap:', Object.keys(RNIap).slice(0, 30));
 return null;
 }
 
 console.log(' IAP module verified - all required methods exist');
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
 console.warn(' IAP not available in Expo Go. Use a development build or TestFlight.');
 return [];
 }

 if (Platform.OS !== 'ios') {
 console.warn(' IAP only supported on iOS');
 return [];
 }

 try {
 const iap = await getIAPModule();
 if (!iap) {
 console.error(' IAP module not available - check if using development build');
 return [];
 }

 // Initialize react-native-iap connection
 if (!isIAPInitialized) {
 if (typeof iap.initConnection !== 'function') {
 console.error(' initConnection is not a function');
 throw new Error('IAP module not properly loaded');
 }
 try {
 await iap.initConnection();
 isIAPInitialized = true;
 console.log(' IAP connection initialized successfully');
 } catch (initError: any) {
 console.error(' Failed to initialize IAP connection:', initError);
 throw new Error(`IAP initialization failed: ${initError?.message || 'Unknown error'}`);
 }
 }

 // FIX: Use getSubscriptions() for auto-renewable subscriptions (not getProducts)
 // For react-native-iap v14.7.0, subscriptions use getSubscriptions()
 let products: Product[] = [];
 let getSubscriptionsMethod: any = null;
 
 // Priority: getSubscriptions first (correct for subscriptions)
 if (typeof iap.getSubscriptions === 'function') {
 getSubscriptionsMethod = iap.getSubscriptions;
 console.log(' Using getSubscriptions() for subscription products');
 } else {
 // Fallback to other methods if getSubscriptions doesn't exist
 const methodNames = ['getProducts', 'getProductsAsync', 'getAvailablePurchases', 'getInAppProducts'];
 for (const methodName of methodNames) {
 if (typeof iap[methodName] === 'function') {
 getSubscriptionsMethod = iap[methodName];
 console.log(` Using fallback ${methodName} method (should use getSubscriptions for subscriptions)`);
 break;
 }
 }
 }
 
 if (!getSubscriptionsMethod) {
 console.error(' getSubscriptions/getProducts method not found');
 console.error('Available function methods:', Object.keys(iap).filter(k => typeof iap[k] === 'function').slice(0, 30));
 throw new Error('getSubscriptions method not available on IAP module');
 }
 
 // For react-native-iap v14.7.0, getSubscriptions uses { skus: [...] } format
 // Try skus first, then productIds as fallback
 try {
 console.log(' Requesting subscriptions with skus:', PRODUCT_ID);
 products = await getSubscriptionsMethod({ skus: [PRODUCT_ID] });
 } catch (skuError: any) {
 console.log(' getSubscriptions with skus failed, trying productIds...');
 try {
 products = await getSubscriptionsMethod({ productIds: [PRODUCT_ID] });
 } catch (productIdError: any) {
 console.log(' getSubscriptions with productIds failed, trying array...');
 products = await getSubscriptionsMethod([PRODUCT_ID]);
 }
 }

 // INSTANT DIAGNOSTIC: Print subscriptions returned from Apple
 console.log(' ========================================');
 console.log(' INSTANT DIAGNOSTIC: Subscriptions from Apple');
 console.log(' ========================================');
 console.log(' Requested Product ID:', PRODUCT_ID);
 console.log(' Subscriptions array length:', products.length);
 if (products.length === 0) {
 console.log(' EMPTY ARRAY - This means:');
 console.log(' Product ID mismatch (check:', PRODUCT_ID, ')');
 console.log(' Product not available in App Store Connect');
 console.log(' Wrong bundle ID');
 console.log(' Wrong storefront');
 console.log(' Product not in "Ready to Submit" state');
 console.log(' Using wrong method (should use getSubscriptions, not getProducts)');
 } else {
 console.log(' Subscriptions found:');
 products.forEach((product, index) => {
 console.log(` [${index}] Product ID: ${product.productId}`);
 console.log(` Title: ${product.title || 'N/A'}`);
 console.log(` Price: ${product.localizedPrice || 'N/A'}`);
 console.log(` Description: ${product.description?.substring(0, 50) || 'N/A'}...`);
 });
 const foundProduct = products.find(p => p.productId === PRODUCT_ID);
 if (foundProduct) {
 console.log(' Expected product ID found:', PRODUCT_ID);
 } else {
 console.log(' Expected product ID NOT found:', PRODUCT_ID);
 console.log(' Found IDs:', products.map(p => p.productId).join(', '));
 }
 }
 console.log(' ========================================');

 if (products.length === 0) {
 console.warn(' No products found. Make sure the product is configured in App Store Connect.');
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
 * Validate that the product is available before purchase
 * Returns true if product is available, throws error if not
 */
export async function validateProductAvailability(): Promise<boolean> {
 if (isExpoGo) {
 throw new Error('IAP not available in Expo Go');
 }

 if (Platform.OS !== 'ios') {
 throw new Error('IAP only supported on iOS');
 }

 try {
 const iap = await getIAPModule();
 if (!iap) {
 throw new Error('IAP module not available');
 }

 // Initialize if not already done
 if (!isIAPInitialized) {
 if (typeof iap.initConnection !== 'function') {
 throw new Error('initConnection is not a function');
 }
 await iap.initConnection();
 isIAPInitialized = true;
 }

 // FIX: Use getSubscriptions() for subscriptions
 let getSubscriptionsMethod: any = null;
 if (typeof iap.getSubscriptions === 'function') {
 getSubscriptionsMethod = iap.getSubscriptions;
 } else {
 // Fallback
 const methodNames = ['getProducts', 'getProductsAsync', 'getAvailablePurchases', 'getInAppProducts'];
 for (const methodName of methodNames) {
 if (typeof iap[methodName] === 'function') {
 getSubscriptionsMethod = iap[methodName];
 break;
 }
 }
 }
 
 if (!getSubscriptionsMethod) {
 throw new Error('getSubscriptions method not available on IAP module');
 }
 
 // For react-native-iap v14.7.0, getSubscriptions uses { skus: [...] } format
 let products: Product[] = [];
 try {
 products = await getSubscriptionsMethod({ skus: [PRODUCT_ID] });
 } catch (skuError: any) {
 try {
 products = await getSubscriptionsMethod({ productIds: [PRODUCT_ID] });
 } catch (productIdError: any) {
 products = await getSubscriptionsMethod([PRODUCT_ID]);
 }
 }

 if (products.length === 0) {
 throw new Error(`Product ${PRODUCT_ID} not found. Ensure it's in "Ready to Submit" state in App Store Connect.`);
 }

 const foundProduct = products.find(p => p.productId === PRODUCT_ID);
 if (!foundProduct) {
 throw new Error(`Product ID mismatch: expected ${PRODUCT_ID} but found ${products.map(p => p.productId).join(', ')}`);
 }

 return true;
 } catch (error: any) {
 console.error('Product validation failed:', error);
 throw error;
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
 console.log(' Getting IAP module...');
 const iap = await getIAPModule();
 if (!iap) {
 console.error(' IAP module is null');
 Alert.alert('Purchase Error', 'In-app purchase system is not available. Please make sure you\'re using a development build or TestFlight.');
 throw new Error('IAP module not available');
 }

 console.log(' IAP module loaded. Available methods:', Object.keys(iap).slice(0, 20));
 console.log(' Checking specific methods:');
 console.log(' - initConnection:', typeof iap.initConnection);
 console.log(' - purchaseUpdatedListener:', typeof iap.purchaseUpdatedListener);
 console.log(' - purchaseErrorListener:', typeof iap.purchaseErrorListener);
 console.log(' - requestSubscription:', typeof iap.requestSubscription, '(for subscriptions)');
 console.log(' - requestPurchase:', typeof iap.requestPurchase, '(fallback)');
 console.log(' - getSubscriptions:', typeof iap.getSubscriptions, '(for subscriptions)');
 console.log(' - getProducts:', typeof iap.getProducts, '(fallback)');
 console.log(' - finishTransaction:', typeof iap.finishTransaction);

 // Initialize if not already done
 if (!isIAPInitialized) {
 console.log(' Initializing IAP connection...');
 if (typeof iap.initConnection !== 'function') {
 console.error(' initConnection is not a function');
 Alert.alert('Purchase Error', 'In-app purchase system is not properly initialized.');
 throw new Error('initConnection is not a function');
 }
 try {
 await iap.initConnection();
 isIAPInitialized = true;
 console.log(' IAP connection initialized');
 } catch (initError: any) {
 console.error(' ERROR in initConnection():', initError);
 console.error(' initConnection error details:', {
 message: initError?.message,
 stack: initError?.stack,
 name: initError?.name,
 code: initError?.code
 });
 throw new Error(`initConnection failed: ${initError?.message || 'Unknown error'}`);
 }
 }

 // FIX: Use getSubscriptions() for auto-renewable subscriptions
 console.log(' Getting subscriptions...');
 let products: Product[] = [];
 try {
 // Priority: getSubscriptions first (correct for subscriptions)
 let getSubscriptionsMethod: any = null;
 if (typeof iap.getSubscriptions === 'function') {
 getSubscriptionsMethod = iap.getSubscriptions;
 console.log(' Using getSubscriptions() for subscription products');
 } else {
 // Fallback to other methods if getSubscriptions doesn't exist
 const methodNames = ['getProducts', 'getProductsAsync', 'getAvailablePurchases', 'getInAppProducts'];
 for (const methodName of methodNames) {
 if (typeof iap[methodName] === 'function') {
 getSubscriptionsMethod = iap[methodName];
 console.log(` Using fallback ${methodName} method (should use getSubscriptions for subscriptions)`);
 break;
 }
 }
 }
 
 if (!getSubscriptionsMethod) {
 console.error(' getSubscriptions/getProducts method not found');
 console.error('Available methods with "subscription" in name:', Object.keys(iap).filter(k => k.toLowerCase().includes('subscription')));
 console.error('All available function methods:', Object.keys(iap).filter(k => typeof iap[k] === 'function').slice(0, 30));
 throw new Error('getSubscriptions method not available on IAP module');
 }
 
 // For react-native-iap v14.7.0, getSubscriptions uses { skus: [...] } format
 try {
 console.log(' Requesting subscriptions with skus:', PRODUCT_ID);
 products = await getSubscriptionsMethod({ skus: [PRODUCT_ID] });
 } catch (skuError: any) {
 console.log(' getSubscriptions with skus failed, trying productIds...');
 try {
 products = await getSubscriptionsMethod({ productIds: [PRODUCT_ID] });
 } catch (productIdError: any) {
 console.log(' getSubscriptions with productIds failed, trying array...');
 products = await getSubscriptionsMethod([PRODUCT_ID]);
 }
 }
 
 // INSTANT DIAGNOSTIC: Print subscriptions returned from Apple
 console.log(' ========================================');
 console.log(' INSTANT DIAGNOSTIC: Subscriptions from Apple');
 console.log(' ========================================');
 console.log(' Requested Product ID:', PRODUCT_ID);
 console.log(' Subscriptions array length:', products.length);
 if (products.length === 0) {
 console.log(' EMPTY ARRAY - This means:');
 console.log(' Product ID mismatch (check:', PRODUCT_ID, ')');
 console.log(' Product not available in App Store Connect');
 console.log(' Wrong bundle ID');
 console.log(' Wrong storefront');
 console.log(' Product not in "Ready to Submit" state');
 console.log(' Using wrong method (should use getSubscriptions, not getProducts)');
 } else {
 console.log(' Subscriptions found:');
 products.forEach((product, index) => {
 console.log(` [${index}] Product ID: ${product.productId}`);
 console.log(` Title: ${product.title || 'N/A'}`);
 console.log(` Price: ${product.localizedPrice || 'N/A'}`);
 console.log(` Description: ${product.description?.substring(0, 50) || 'N/A'}...`);
 });
 const foundProduct = products.find(p => p.productId === PRODUCT_ID);
 if (foundProduct) {
 console.log(' Expected product ID found:', PRODUCT_ID);
 } else {
 console.log(' Expected product ID NOT found:', PRODUCT_ID);
 console.log(' Found IDs:', products.map(p => p.productId).join(', '));
 }
 }
 console.log(' ========================================');
 console.log(' getProducts returned:', products.length, 'products');
 } catch (getProductsError: any) {
 console.error(' ERROR in getProducts():', getProductsError);
 console.error(' getProducts error details:', {
 message: getProductsError?.message,
 stack: getProductsError?.stack,
 name: getProductsError?.name,
 code: getProductsError?.code
 });
 throw new Error(`getProducts failed: ${getProductsError?.message || 'Unknown error'}`);
 }
 if (products.length === 0) {
 // INSTANT DIAGNOSTIC: Empty products array
 console.error(' ========================================');
 console.error(' INSTANT DIAGNOSTIC: EMPTY PRODUCTS ARRAY');
 console.error(' ========================================');
 console.error('This means one of these issues:');
 console.error(' 1. Product ID mismatch - Expected:', PRODUCT_ID);
 console.error(' 2. Product not available in App Store Connect');
 console.error(' 3. Wrong bundle ID');
 console.error(' 4. Wrong storefront');
 console.error(' 5. Product not in "Ready to Submit" state');
 console.error(' 6. Product not included in app submission');
 console.error(' 7. Paid Apps Agreement not accepted');
 console.error(' 8. Testing in sandbox but not signed in with sandbox account');
 console.error(' 9. Product not yet propagated (wait 5-10 minutes)');
 console.error(' ========================================');
 throw new Error('Product not available - ensure subscription is in "Ready to Submit" state and included in app submission');
 }
 
 // Verify the product ID matches
 const foundProduct = products.find(p => p.productId === PRODUCT_ID);
 if (!foundProduct) {
 console.error(' Product ID mismatch!');
 console.error(' Expected:', PRODUCT_ID);
 console.error(' Found products:', products.map(p => p.productId));
 throw new Error(`Product ID mismatch: expected ${PRODUCT_ID} but found ${products.map(p => p.productId).join(', ')}`);
 }
 
 console.log(' Product verified:', {
 productId: foundProduct.productId,
 title: foundProduct.title,
 price: foundProduct.localizedPrice,
 });

 // Verify IAP methods exist before using them
 if (typeof iap.purchaseUpdatedListener !== 'function') {
 console.error(' purchaseUpdatedListener is not a function');
 console.log('IAP module methods:', Object.keys(iap));
 Alert.alert('Purchase Error', 'In-app purchase system is not properly initialized. Please restart the app.');
 throw new Error('purchaseUpdatedListener is not a function');
 }
 
 if (typeof iap.purchaseErrorListener !== 'function') {
 console.error(' purchaseErrorListener is not a function');
 Alert.alert('Purchase Error', 'In-app purchase system is not properly initialized. Please restart the app.');
 throw new Error('purchaseErrorListener is not a function');
 }
 
 // FIX: Use requestSubscription() for subscriptions (not requestPurchase)
 if (typeof iap.requestSubscription !== 'function' && typeof iap.requestPurchase !== 'function') {
 console.error(' requestSubscription/requestPurchase is not a function');
 Alert.alert('Purchase Error', 'In-app purchase system is not properly initialized. Please restart the app.');
 throw new Error('requestSubscription/requestPurchase method not available');
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

 console.log(' Setting up purchase listeners...');
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
 
 console.log(' Purchase successful:', {
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
 console.log(' purchaseUpdatedListener set up');
 } catch (listenerError: any) {
 console.error(' ERROR setting up purchaseUpdatedListener:', listenerError);
 console.error(' Listener error details:', {
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
 console.log(' purchaseErrorListener set up');
 } catch (errorListenerError: any) {
 console.error(' ERROR setting up purchaseErrorListener:', errorListenerError);
 console.error(' Error listener error details:', {
 message: errorListenerError?.message,
 stack: errorListenerError?.stack,
 name: errorListenerError?.name
 });
 throw new Error(`purchaseErrorListener setup failed: ${errorListenerError?.message || 'Unknown error'}`);
 }

 // FIX: Attempt purchase using requestSubscription() for subscriptions
 try {
 console.log(' Requesting subscription purchase for:', PRODUCT_ID);
 
 // Priority: requestSubscription first (correct for subscriptions)
 let requestMethod: any = null;
 let methodName = '';
 
 if (typeof iap.requestSubscription === 'function') {
 requestMethod = iap.requestSubscription;
 methodName = 'requestSubscription';
 console.log(' Using requestSubscription() for subscription purchase');
 } else if (typeof iap.requestPurchase === 'function') {
 requestMethod = iap.requestPurchase;
 methodName = 'requestPurchase';
 console.log(' Using requestPurchase() as fallback (should use requestSubscription for subscriptions)');
 } else {
 console.error(' CRITICAL: requestSubscription/requestPurchase is not a function!');
 console.error('IAP object:', iap);
 console.error('All IAP methods:', Object.keys(iap));
 throw new Error('requestSubscription/requestPurchase method is not available on IAP module');
 }
 
 // For react-native-iap v14.7.0, requestSubscription uses { sku: ... } format
 // Try sku first, then productId as fallback
 try {
 console.log(` Calling ${methodName} with sku:`, PRODUCT_ID);
 await requestMethod({ sku: PRODUCT_ID });
 console.log(` ${methodName}({ sku }) call completed`);
 } catch (skuError: any) {
 console.error(` ERROR in ${methodName}({ sku }):`, skuError);
 console.error(` ${methodName} sku error details:`, {
 message: skuError?.message,
 stack: skuError?.stack,
 name: skuError?.name,
 code: skuError?.code
 });
 // If sku fails, try productId (v14 might use this)
 if (skuError?.message?.includes('sku') || skuError?.code === 'E_DEVELOPER_ERROR') {
 console.log(` ${methodName} with sku failed, trying productId...`);
 try {
 await requestMethod({ productId: PRODUCT_ID });
 console.log(` ${methodName}({ productId }) call completed`);
 } catch (productIdError: any) {
 console.error(` ERROR in ${methodName}({ productId }):`, productIdError);
 console.error(` ${methodName} productId error details:`, {
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
 
 // Show user-friendly error message with better diagnostics
 let userMessage = 'Unable to complete purchase.';
 let errorTitle = 'Purchase Unavailable';
 
 // Provide more helpful messages based on error type
 if (error?.message?.includes('timeout')) {
 userMessage = 'The purchase took too long. Please check your internet connection and try again.';
 } else if (error?.message?.includes('network') || error?.message?.includes('connection')) {
 userMessage = 'Network error. Please check your internet connection and try again.';
 } else if (error?.code === 'E_SERVICE_ERROR' || error?.code === 'E_NETWORK_ERROR') {
 userMessage = 'Unable to connect to the App Store. Please check your internet connection and try again.';
 } else if (error?.code === 'E_ITEM_UNAVAILABLE' || error?.message?.includes('Product not available')) {
 errorTitle = 'Subscription Unavailable';
 userMessage = 'This subscription is temporarily unavailable. Please ensure:\n\n The subscription is approved in App Store Connect\n You\'re using a development build or TestFlight\n You\'re signed in with a sandbox account (for testing)';
 } else if (error?.message?.includes('getProducts failed') || error?.message?.includes('Product not available')) {
 errorTitle = 'Subscription Not Found';
 userMessage = 'The subscription product could not be found. Please verify:\n\n Product ID matches App Store Connect: ' + PRODUCT_ID + '\n Product is in "Ready to Submit" or "Approved" state\n Product is included in your app submission';
 } else if (error?.message?.includes('initConnection failed')) {
 errorTitle = 'Initialization Error';
 userMessage = 'Failed to initialize the purchase system. Please:\n\n Restart the app\n Ensure you\'re using a development build or TestFlight\n Check your internet connection';
 } else if (error?.message?.includes('IAP module not available')) {
 errorTitle = 'Purchase System Unavailable';
 userMessage = 'In-app purchases are not available. Please:\n\n Use a development build or TestFlight (not Expo Go)\n Test on a physical device (not simulator)\n Ensure react-native-iap is properly installed';
 } else if (error?.message?.includes('not available')) {
 userMessage = 'In-app purchases are not available right now. Please try again later.';
 }
 
 // Log detailed error for debugging
 console.error(' Purchase Error Summary:', {
 title: errorTitle,
 message: userMessage,
 errorCode: error?.code,
 errorMessage: error?.message,
 productId: PRODUCT_ID,
 isExpoGo,
 platform: Platform.OS,
 });
 
 Alert.alert(
 errorTitle, 
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
 // FEATURE FLAG: Check if pro is enabled for everyone
 // Import the flag from subscriptionService
 try {
 const { checkSubscriptionStatus: checkSubStatus } = await import('./subscriptionService');
 const status = await checkSubStatus();
 // If subscriptionService returns 'pro' (due to feature flag), return it
 if (status === 'pro') {
 return 'pro';
 }
 } catch (error) {
 // If import fails, continue with normal check
 }

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
 console.error(' Supabase not available');
 throw new Error('Database not available');
 }

 try {
 // Get current user
 const { data: { user }, error: userError } = await supabase.auth.getUser();
 
 if (userError || !user) {
 console.error(' No authenticated user:', userError);
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
 console.error(' Error updating subscription in Supabase:', updateError);
 throw new Error('Failed to update subscription status');
 }

 console.log(' Subscription updated in Supabase:', {
 userId: user.id,
 tier: 'pro',
 transactionId,
 });

 // Also validate receipt server-side for security
 try {
 await validateReceiptServerSide(transactionId, originalTransactionId);
 } catch (validationError) {
 console.warn(' Server-side receipt validation failed (non-critical):', validationError);
 // Don't throw - client update succeeded
 }
 } catch (error: any) {
 console.error(' Error updating subscription:', error);
 throw error;
 }
}

/**
 * Check subscription status from Supabase
 */
async function checkSubscriptionFromSupabase(): Promise<'free' | 'pro'> {
 // FEATURE FLAG: Check if pro is enabled for everyone
 try {
 const { checkSubscriptionStatus: checkSubStatus } = await import('./subscriptionService');
 const status = await checkSubStatus();
 // If subscriptionService returns 'pro' (due to feature flag), return it
 if (status === 'pro') {
 return 'pro';
 }
 } catch (error) {
 // If import fails, continue with normal check
 }

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

 const _receiptAuthHeaders = await getScanAuthHeaders();
 const response = await fetch(`${apiBaseUrl}/api/validate-apple-receipt`, {
 method: 'POST',
 headers: {
 ..._receiptAuthHeaders,
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

 console.log(' Receipt validated server-side');
 } catch (error: any) {
 console.error('Receipt validation error:', error);
 throw error;
 }
}

/**
 * Diagnostic function to check IAP setup and configuration
 * Use this to debug IAP issues
 */
export async function diagnoseIAPSetup(): Promise<{
 isExpoGo: boolean;
 platform: string;
 iapModuleAvailable: boolean;
 iapInitialized: boolean;
 productId: string;
 productsFound: number;
 productDetails?: IAPProduct[];
 errors: string[];
}> {
 const diagnostics = {
 isExpoGo,
 platform: Platform.OS,
 iapModuleAvailable: false,
 iapInitialized: false,
 productId: PRODUCT_ID,
 productsFound: 0,
 productDetails: undefined as IAPProduct[] | undefined,
 errors: [] as string[],
 };

 try {
 // Check environment
 if (isExpoGo) {
 diagnostics.errors.push('Running in Expo Go - IAP will not work. Use development build or TestFlight.');
 return diagnostics;
 }

 if (Platform.OS !== 'ios') {
 diagnostics.errors.push(`Platform is ${Platform.OS} - IAP only works on iOS`);
 return diagnostics;
 }

 // Check IAP module
 try {
 const iap = await getIAPModule();
 if (!iap) {
 diagnostics.errors.push('IAP module is null - check if react-native-iap is installed and app is rebuilt');
 return diagnostics;
 }
 diagnostics.iapModuleAvailable = true;

 // Check initialization
 if (isIAPInitialized) {
 diagnostics.iapInitialized = true;
 } else {
 try {
 if (typeof iap.initConnection === 'function') {
 await iap.initConnection();
 isIAPInitialized = true;
 diagnostics.iapInitialized = true;
 } else {
 diagnostics.errors.push('initConnection is not a function on IAP module');
 }
 } catch (initError: any) {
 diagnostics.errors.push(`initConnection failed: ${initError?.message || 'Unknown error'}`);
 }
 }

 // Try to get products
 if (diagnostics.iapInitialized) {
 try {
 const products = await initializeIAP();
 diagnostics.productsFound = products.length;
 diagnostics.productDetails = products;

 if (products.length === 0) {
 diagnostics.errors.push(`No products found for ID: ${PRODUCT_ID}. Check App Store Connect configuration.`);
 } else {
 const foundProduct = products.find(p => p.productId === PRODUCT_ID);
 if (!foundProduct) {
 diagnostics.errors.push(`Product ID mismatch: expected ${PRODUCT_ID} but found ${products.map(p => p.productId).join(', ')}`);
 }
 }
 } catch (productError: any) {
 diagnostics.errors.push(`Failed to get products: ${productError?.message || 'Unknown error'}`);
 }
 }
 } catch (moduleError: any) {
 diagnostics.errors.push(`Failed to load IAP module: ${moduleError?.message || 'Unknown error'}`);
 }
 } catch (error: any) {
 diagnostics.errors.push(`Diagnostic error: ${error?.message || 'Unknown error'}`);
 }

 return diagnostics;
}
