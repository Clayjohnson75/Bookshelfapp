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
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
// import { purchaseProSubscription, restorePurchases, checkSubscriptionStatus } from '../services/appleIAPService';
import { checkSubscriptionStatus } from '../services/subscriptionService';
import { useAuth } from '../auth/SimpleAuthContext';
import { supabase } from '../lib/supabaseClient';

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

  useEffect(() => {
    if (visible && user) {
      checkCurrentTier();
    }
  }, [visible, user]);

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
      // TODO: When Apple IAP is implemented, use purchaseProSubscription() here
      // For now, show message that IAP is coming soon
      Alert.alert(
        'Coming Soon',
        'In-App Purchase integration is coming soon! For now, Pro accounts can be activated manually for testing.\n\nContact support to upgrade your account.',
        [
          { text: 'OK', onPress: () => setLoading(false) }
        ]
      );
      
      // Uncomment this when IAP is ready:
      // await purchaseProSubscription();
      // setTimeout(async () => {
      //   await checkCurrentTier();
      //   if (onUpgradeComplete) {
      //     onUpgradeComplete();
      //   }
      //   setLoading(false);
      // }, 2000);
    } catch (error: any) {
      console.error('Purchase error:', error);
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    setRestoring(true);
    try {
      // TODO: When Apple IAP is implemented, use restorePurchases() here
      Alert.alert(
        'Coming Soon',
        'Purchase restoration will be available when In-App Purchases are enabled.',
        [{ text: 'OK', onPress: () => setRestoring(false) }]
      );
      
      // Uncomment this when IAP is ready:
      // const restored = await restorePurchases();
      // if (restored) {
      //   await checkCurrentTier();
      //   if (onUpgradeComplete) {
      //     onUpgradeComplete();
      //   }
      // }
    } catch (error: any) {
      console.error('Restore error:', error);
      setRestoring(false);
    }
  };

  if (currentTier === 'pro') {
    return (
      <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
          <View style={styles.header}>
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
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Upgrade to Pro</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeButtonText}>✕</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.pricingCard}>
            <Text style={styles.price}>$4.99</Text>
            <Text style={styles.pricePeriod}>per month</Text>
          </View>

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
    paddingVertical: 16,
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
    marginBottom: 20,
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

