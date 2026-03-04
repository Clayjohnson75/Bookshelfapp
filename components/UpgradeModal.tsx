import React, { useState, useEffect } from 'react';
import {
 View,
 Text,
 Modal,
 TouchableOpacity,
 StyleSheet,
 ScrollView,
 ActivityIndicator,
 Alert,
 Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { initializeIAP, purchaseProSubscription, restorePurchases, checkSubscriptionStatus as checkIAPStatus } from '../services/appleIAPService';
import { checkSubscriptionStatus, isSubscriptionUIHidden } from '../services/subscriptionService';
import { useAuth } from '../auth/SimpleAuthContext';
import { useTheme } from '../theme/ThemeProvider';
import { AppHeader } from './AppHeader';

interface UpgradeModalProps {
 visible: boolean;
 onClose: () => void;
 onUpgradeComplete?: () => void;
}

export const UpgradeModal: React.FC<UpgradeModalProps> = ({
 visible,
 onClose,
 onUpgradeComplete,
}) => {
 const { user } = useAuth();
 const { t } = useTheme();
 const [loading, setLoading] = useState(false);
 const [restoring, setRestoring] = useState(false);
 const [currentTier, setCurrentTier] = useState<'free' | 'pro'>('free');
 const [products, setProducts] = useState<Array<{ productId: string; title: string; localizedPrice: string }>>([]);
 const [loadingProducts, setLoadingProducts] = useState(true);

 // FEATURE FLAG: Hide subscription UI when pro is enabled for everyone
 if (isSubscriptionUIHidden()) {
 // If visible prop is true but feature flag is enabled, close immediately
 if (visible) {
 // Close the modal immediately
 setTimeout(() => {
 onClose();
 }, 0);
 }
 return null; // Don't render anything
 }

 useEffect(() => {
 if (visible && user) {
 checkCurrentTier();
 loadProducts();
 }
 }, [visible, user]);

 const loadProducts = async () => {
 setLoadingProducts(true);
 try {
 const availableProducts = await initializeIAP();
 setProducts(availableProducts);
 } catch (error) {
 console.error('Error loading products:', error);
 } finally {
 setLoadingProducts(false);
 }
 };

 const checkCurrentTier = async () => {
 if (!user) return;
 const tier = await checkSubscriptionStatus();
 setCurrentTier(tier);
 };

 const handlePurchase = async () => {
 if (!user) {
 Alert.alert('Error', 'Please sign in to upgrade');
 return;
 }

 setLoading(true);
 try {
 // Purchase is handled by appleIAPService which updates Supabase automatically
 await purchaseProSubscription();
 
 // Wait a moment for the purchase to process, then refresh status
 // Use a shorter delay and ensure loading is always cleared
 setTimeout(async () => {
 try {
 await checkCurrentTier();
 if (onUpgradeComplete) {
 onUpgradeComplete();
 }
 } catch (refreshError) {
 console.error('Error refreshing subscription status:', refreshError);
 } finally {
 setLoading(false);
 }
 }, 1500); // Reduced from 2000ms for faster feedback
 } catch (error: any) {
 console.error('Purchase error in UpgradeModal:', error);
 // Error alerts are handled by appleIAPService
 // Ensure loading state is always cleared
 setLoading(false);
 
 // Don't show duplicate error if user cancelled
 if (error?.message?.includes('cancelled') || error?.message?.includes('User cancelled')) {
 // User cancelled - just clear loading state, no error needed
 return;
 }
 }
 };

 const handleRestore = async () => {
 setRestoring(true);
 try {
 const restored = await restorePurchases();
 
 if (restored) {
 // Wait a moment for restore to process
 setTimeout(async () => {
 await checkCurrentTier();
 const newTier = await checkIAPStatus();
 
 if (newTier === 'pro') {
 Alert.alert('Success', 'Your Pro subscription has been restored!');
 if (onUpgradeComplete) {
 onUpgradeComplete();
 }
 } else {
 Alert.alert('No Subscription', 'No active Pro subscription found to restore.');
 }
 setRestoring(false);
 }, 2000);
 } else {
 setRestoring(false);
 }
 } catch (error: any) {
 console.error('Restore error:', error);
 // Error alerts are handled by appleIAPService
 setRestoring(false);
 }
 };

 if (currentTier === 'pro') {
 return (
 <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
 <SafeAreaView style={[styles.container, { backgroundColor: t.colors.bg }]} edges={['bottom']}>
 <AppHeader title="Pro Account Active" onBack={onClose} />
 <ScrollView style={[styles.content, { backgroundColor: t.colors.bg }]}>
 <View style={[styles.proBadge, { backgroundColor: t.colors.accent }]}>
 <Text style={[styles.proBadgeText, { color: t.colors.primaryText }]}>PRO</Text>
 </View>
 <Text style={[styles.successTitle, { color: t.colors.text }]}>You're all set!</Text>
 <Text style={[styles.successText, { color: t.colors.textMuted }]}>
 Your Pro subscription is active. Enjoy unlimited scans!
 </Text>
 </ScrollView>
 </SafeAreaView>
 </Modal>
 );
 }

 return (
 <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
 <SafeAreaView style={[styles.container, { backgroundColor: t.colors.bg }]} edges={['bottom']}>
 <AppHeader title="Upgrade to Pro" onBack={onClose} />

 <ScrollView style={[styles.content, { backgroundColor: t.colors.bg }]} showsVerticalScrollIndicator={false}>
 {loadingProducts ? (
 <View style={[styles.pricingCard, { backgroundColor: t.colors.card, borderColor: t.colors.border }]}>
 <ActivityIndicator size="large" color={t.colors.primary} />
 <Text style={[styles.pricePeriod, { color: t.colors.textMuted }]}>Loading subscription...</Text>
 </View>
 ) : products.length > 0 ? (
 <View style={[styles.pricingCard, { backgroundColor: t.colors.card, borderColor: t.colors.border }]}>
 <Text style={[styles.subscriptionTitle, { color: t.colors.text }]}>{products[0].title}</Text>
 <Text style={[styles.price, { color: t.colors.text }]}>{products[0].localizedPrice}</Text>
 <Text style={[styles.pricePeriod, { color: t.colors.textMuted }]}>per month</Text>
 <Text style={[styles.subscriptionLength, { color: t.colors.textMuted }]}>Auto-renewable subscription, 1 month duration</Text>
 </View>
 ) : (
 <View style={[styles.pricingCard, { backgroundColor: t.colors.card, borderColor: t.colors.border }]}>
 <Text style={[styles.subscriptionTitle, { color: t.colors.text }]}>Pro Monthly Subscription</Text>
 <Text style={[styles.price, { color: t.colors.text }]}>$4.99</Text>
 <Text style={[styles.pricePeriod, { color: t.colors.textMuted }]}>per month</Text>
 <Text style={[styles.subscriptionLength, { color: t.colors.textMuted }]}>Auto-renewable subscription, 1 month duration</Text>
 </View>
 )}

 {/* Prominent Terms and Privacy Links - Required by Apple Guidelines 3.1.2 */}
 <View style={styles.legalLinksSection}>
 <TouchableOpacity
 onPress={() => Linking.openURL('https://bookshelfscan.app/terms.html')}
 style={styles.legalLinkButton}
 >
 <Text style={[styles.legalLinkText, { color: t.colors.linkMuted ?? t.colors.primary }]}>Terms of Use (EULA)</Text>
 </TouchableOpacity>
 <TouchableOpacity
 onPress={() => Linking.openURL('https://bookshelfscan.app/privacy.html')}
 style={[styles.legalLinkButton, styles.lastLegalLinkButton]}
 >
 <Text style={[styles.legalLinkText, { color: t.colors.linkMuted ?? t.colors.primary }]}>Privacy Policy</Text>
 </TouchableOpacity>
 </View>

 <View style={styles.benefitsSection}>
 <Text style={[styles.benefitsTitle, { color: t.colors.text }]}>Pro Features</Text>
 {[
 'Unlimited book scans per month',
 'No scan limits or restrictions',
 'Priority support',
 'All premium features',
 'Cancel anytime',
 ].map((benefit, index) => (
 <View key={index} style={styles.benefitRow}>
 <Text style={[styles.checkmark, { color: t.colors.primary }]}></Text>
 <Text style={[styles.benefitText, { color: t.colors.text }]}>{benefit}</Text>
 </View>
 ))}
 </View>

 <TouchableOpacity
 style={[styles.subscribeButton, { backgroundColor: t.colors.primary }, loading && styles.subscribeButtonDisabled]}
 onPress={handlePurchase}
 disabled={loading}
 >
 {loading ? (
 <ActivityIndicator size="small" color={t.colors.primaryText} />
 ) : (
 <Text style={[styles.subscribeButtonText, { color: t.colors.primaryText }]}>Subscribe to Pro</Text>
 )}
 </TouchableOpacity>

 <TouchableOpacity
 style={[styles.restoreButton, { backgroundColor: t.colors.surface2, borderColor: t.colors.border }]}
 onPress={handleRestore}
 disabled={restoring}
 >
 {restoring ? (
 <ActivityIndicator size="small" color={t.colors.primary} />
 ) : (
 <Text style={[styles.restoreButtonText, { color: t.colors.text }]}>Restore Purchases</Text>
 )}
 </TouchableOpacity>

 <Text style={[styles.disclaimer, { color: t.colors.textMuted }]}>
 Payment will be charged to your Apple ID account at confirmation. Subscription
 automatically renews unless cancelled at least 24 hours before the end of the current period.
 </Text>

 {/* Additional Terms and Privacy Links at bottom */}
 <View style={styles.linksContainer}>
 <TouchableOpacity
 onPress={() => Linking.openURL('https://bookshelfscan.app/terms.html')}
 style={styles.linkButton}
 >
 <Text style={[styles.linkText, { color: t.colors.linkMuted ?? t.colors.primary }]}>Terms of Use</Text>
 </TouchableOpacity>
 <Text style={[styles.linkSeparator, { color: t.colors.textMuted }]}> </Text>
 <TouchableOpacity
 onPress={() => Linking.openURL('https://bookshelfscan.app/privacy.html')}
 style={styles.linkButton}
 >
 <Text style={[styles.linkText, { color: t.colors.linkMuted ?? t.colors.primary }]}>Privacy Policy</Text>
 </TouchableOpacity>
 </View>
 </ScrollView>
 </SafeAreaView>
 </Modal>
 );
};

const styles = StyleSheet.create({
 container: {
 flex: 1,
 backgroundColor: '#f8f9fa',
 },
 content: {
 flex: 1,
 padding: 20,
 },
 pricingCard: {
 backgroundColor: '#ffffff',
 borderRadius: 16,
 padding: 32,
 alignItems: 'center',
 marginBottom: 24,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.1,
 shadowRadius: 8,
 elevation: 3,
 },
 price: {
 fontSize: 48,
 fontWeight: '700',
 color: '#2d3748',
 },
 pricePeriod: {
 fontSize: 16,
 color: '#718096',
 marginTop: 4,
 },
 productTitle: {
 fontSize: 14,
 color: '#718096',
 marginTop: 8,
 textAlign: 'center',
 },
 benefitsSection: {
 backgroundColor: '#ffffff',
 borderRadius: 16,
 padding: 24,
 marginBottom: 24,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.1,
 shadowRadius: 8,
 elevation: 3,
 },
 benefitsTitle: {
 fontSize: 20,
 fontWeight: '700',
 color: '#2d3748',
 marginBottom: 16,
 },
 benefitRow: {
 flexDirection: 'row',
 alignItems: 'center',
 marginBottom: 12,
 },
 checkmark: {
 fontSize: 18,
 color: '#48bb78',
 marginRight: 12,
 fontWeight: '700',
 },
 benefitText: {
 fontSize: 16,
 color: '#4a5568',
 flex: 1,
 },
 subscribeButton: {
 backgroundColor: '#4299e1',
 borderRadius: 12,
 paddingVertical: 16,
 paddingHorizontal: 24,
 alignItems: 'center',
 marginBottom: 12,
 shadowColor: '#4299e1',
 shadowOffset: { width: 0, height: 4 },
 shadowOpacity: 0.3,
 shadowRadius: 8,
 elevation: 5,
 },
 subscribeButtonDisabled: {
 opacity: 0.6,
 },
 subscribeButtonText: {
 color: '#ffffff',
 fontSize: 18,
 fontWeight: '700',
 },
 restoreButton: {
 paddingVertical: 12,
 alignItems: 'center',
 marginBottom: 24,
 },
 restoreButtonText: {
 color: '#4299e1',
 fontSize: 15,
 fontWeight: '600',
 },
 disclaimer: {
 fontSize: 12,
 color: '#718096',
 textAlign: 'center',
 lineHeight: 18,
 marginBottom: 16,
 },
 subscriptionTitle: {
 fontSize: 18,
 fontWeight: '600',
 color: '#2d3748',
 marginBottom: 8,
 textAlign: 'center',
 },
 subscriptionLength: {
 fontSize: 12,
 color: '#718096',
 marginTop: 4,
 textAlign: 'center',
 },
 legalLinksSection: {
 backgroundColor: '#ffffff',
 borderRadius: 12,
 padding: 20,
 marginBottom: 24,
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 2 },
 shadowOpacity: 0.1,
 shadowRadius: 8,
 elevation: 3,
 },
 legalLinkButton: {
 backgroundColor: '#f7fafc',
 borderRadius: 8,
 paddingVertical: 14,
 paddingHorizontal: 20,
 marginBottom: 12,
 borderWidth: 1,
 borderColor: '#e2e8f0',
 alignItems: 'center',
 },
 legalLinkText: {
 fontSize: 15,
 color: '#4299e1',
 fontWeight: '600',
 textDecorationLine: 'underline',
 },
 lastLegalLinkButton: {
 marginBottom: 0,
 },
 linksContainer: {
 flexDirection: 'row',
 justifyContent: 'center',
 alignItems: 'center',
 marginTop: 8,
 marginBottom: 20,
 },
 linkButton: {
 paddingVertical: 8,
 paddingHorizontal: 4,
 },
 linkText: {
 fontSize: 12,
 color: '#4299e1',
 textDecorationLine: 'underline',
 },
 linkSeparator: {
 fontSize: 12,
 color: '#718096',
 },
 proBadge: {
 backgroundColor: '#48bb78',
 alignSelf: 'center',
 paddingHorizontal: 20,
 paddingVertical: 8,
 borderRadius: 20,
 marginBottom: 16,
 },
 proBadgeText: {
 color: '#ffffff',
 fontSize: 16,
 fontWeight: '700',
 letterSpacing: 2,
 },
 successTitle: {
 fontSize: 24,
 fontWeight: '700',
 color: '#2d3748',
 textAlign: 'center',
 marginBottom: 12,
 },
 successText: {
 fontSize: 16,
 color: '#4a5568',
 textAlign: 'center',
 lineHeight: 24,
 },
});

