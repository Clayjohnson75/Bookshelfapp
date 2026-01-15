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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { initializeIAP, purchaseProSubscription, restorePurchases, checkSubscriptionStatus as checkIAPStatus } from '../services/appleIAPService';
import { checkSubscriptionStatus } from '../services/subscriptionService';
import { useAuth } from '../auth/SimpleAuthContext';

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
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [currentTier, setCurrentTier] = useState<'free' | 'pro'>('free');
  const [products, setProducts] = useState<Array<{ productId: string; title: string; localizedPrice: string }>>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);

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
      
      // Wait a moment for the purchase to process
      setTimeout(async () => {
        await checkCurrentTier();
        if (onUpgradeComplete) {
          onUpgradeComplete();
        }
        setLoading(false);
      }, 2000);
    } catch (error: any) {
      console.error('Purchase error:', error);
      // Error alerts are handled by appleIAPService
      setLoading(false);
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
        <SafeAreaView style={styles.container} edges={['bottom']}>
          <View style={[styles.header, { paddingTop: Math.max(insets.top, 20) + 16 }]}>
            <Text style={styles.headerTitle}>Pro Account Active</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.content}>
            <View style={styles.proBadge}>
              <Text style={styles.proBadgeText}>PRO</Text>
            </View>
            <Text style={styles.successTitle}>You're all set!</Text>
            <Text style={styles.successText}>
              Your Pro subscription is active. Enjoy unlimited scans!
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <View style={[styles.header, { paddingTop: Math.max(insets.top, 20) + 16 }]}>
          <Text style={styles.headerTitle}>Upgrade to Pro</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeButtonText}>✕</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
          {loadingProducts ? (
            <View style={styles.pricingCard}>
              <ActivityIndicator size="large" color="#4299e1" />
              <Text style={styles.pricePeriod}>Loading subscription...</Text>
            </View>
          ) : products.length > 0 ? (
            <View style={styles.pricingCard}>
              <Text style={styles.subscriptionTitle}>{products[0].title}</Text>
              <Text style={styles.price}>{products[0].localizedPrice}</Text>
              <Text style={styles.pricePeriod}>per month</Text>
              <Text style={styles.subscriptionLength}>Auto-renewable subscription, 1 month duration</Text>
            </View>
          ) : (
            <View style={styles.pricingCard}>
              <Text style={styles.subscriptionTitle}>Pro Monthly Subscription</Text>
              <Text style={styles.price}>$4.99</Text>
              <Text style={styles.pricePeriod}>per month</Text>
              <Text style={styles.subscriptionLength}>Auto-renewable subscription, 1 month duration</Text>
            </View>
          )}

          <View style={styles.benefitsSection}>
            <Text style={styles.benefitsTitle}>Pro Features</Text>
            {[
              'Unlimited book scans per month',
              'No scan limits or restrictions',
              'Priority support',
              'All premium features',
              'Cancel anytime',
            ].map((benefit, index) => (
              <View key={index} style={styles.benefitRow}>
                <Text style={styles.checkmark}>✓</Text>
                <Text style={styles.benefitText}>{benefit}</Text>
              </View>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.subscribeButton, loading && styles.subscribeButtonDisabled]}
            onPress={handlePurchase}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Text style={styles.subscribeButtonText}>Subscribe to Pro</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.restoreButton}
            onPress={handleRestore}
            disabled={restoring}
          >
            {restoring ? (
              <ActivityIndicator size="small" color="#4299e1" />
            ) : (
              <Text style={styles.restoreButtonText}>Restore Purchases</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.disclaimer}>
            Payment will be charged to your Apple ID account at confirmation. Subscription
            automatically renews unless cancelled at least 24 hours before the end of the current period.
          </Text>

          <View style={styles.linksContainer}>
            <TouchableOpacity
              onPress={() => Linking.openURL('https://bookshelfscan.app/terms.html')}
              style={styles.linkButton}
            >
              <Text style={styles.linkText}>Terms of Use</Text>
            </TouchableOpacity>
            <Text style={styles.linkSeparator}> • </Text>
            <TouchableOpacity
              onPress={() => Linking.openURL('https://bookshelfscan.app/privacy.html')}
              style={styles.linkButton}
            >
              <Text style={styles.linkText}>Privacy Policy</Text>
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
  header: {
    backgroundColor: '#2d3748',
    paddingBottom: 16,
    paddingHorizontal: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
  },
  closeButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 24,
    color: '#ffffff',
    fontWeight: '300',
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

