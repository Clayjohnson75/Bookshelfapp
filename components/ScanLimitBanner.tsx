import React, { useState, useEffect, useImperativeHandle, forwardRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../auth/SimpleAuthContext';
import { getUserScanUsage, formatResetDate, ScanUsage, isSubscriptionUIHidden } from '../services/subscriptionService';

interface ScanLimitBannerProps {
  onUpgradePress: () => void;
}

export interface ScanLimitBannerRef {
  refresh: () => void;
}

export const ScanLimitBanner = forwardRef<ScanLimitBannerRef, ScanLimitBannerProps>(
  ({ onUpgradePress }, ref) => {
    const { user } = useAuth();
    const [usage, setUsage] = useState<ScanUsage | null>(null);
    const [loading, setLoading] = useState(true);

    const loadUsage = async () => {
      if (!user) return;
      
      setLoading(true);
      const scanUsage = await getUserScanUsage(user.uid);
      setUsage(scanUsage);
      setLoading(false);
    };

    // Expose refresh function via ref
    useImperativeHandle(ref, () => ({
      refresh: loadUsage
    }));

    useEffect(() => {
      if (user) {
        loadUsage();
      } else {
        // Clear usage when user signs out
        setUsage(null);
        setLoading(false);
      }
    }, [user?.uid]); // Use user.uid instead of user object to catch sign-in events

    // Refresh when tab is focused
    useFocusEffect(
      React.useCallback(() => {
        if (user) {
          loadUsage();
        }
      }, [user?.uid]) // Use user.uid instead of user object
    );

    if (loading || !usage) {
      return null;
    }

    // 🎛️ FEATURE FLAG: Hide banner completely when pro is enabled for everyone
    if (isSubscriptionUIHidden()) {
      return null;
    }

    // Don't show banner for pro or owner users
    if (usage.subscriptionTier === 'pro' || usage.subscriptionTier === 'owner') {
      return null;
    }

    // Don't show if unlimited scans remaining
    if (usage.scansRemaining === null || usage.scansRemaining > 0) {
      return (
        <TouchableOpacity 
          style={styles.banner}
          onPress={onUpgradePress}
          activeOpacity={0.7}
        >
          <Text style={styles.bannerText}>
            {usage.scansRemaining} scan{usage.scansRemaining !== 1 ? 's' : ''} remaining this month
          </Text>
          <Text style={styles.bannerSubtext}>{formatResetDate(usage.resetAt)}</Text>
          <Text style={styles.bannerHint}>Tap to upgrade to Pro for unlimited scans</Text>
        </TouchableOpacity>
      );
    }

    // Show upgrade prompt if limit reached
    return (
      <View style={[styles.banner, styles.limitReachedBanner]}>
        <Text style={styles.limitReachedText}>
          You've used all {usage.monthlyLimit} free scans this month
        </Text>
        <Text style={styles.bannerSubtext}>{formatResetDate(usage.resetAt)}</Text>
        <TouchableOpacity style={styles.upgradeButton} onPress={onUpgradePress}>
          <Text style={styles.upgradeButtonText}>Upgrade to Pro</Text>
        </TouchableOpacity>
      </View>
    );
  }
);

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#edf2f7',
    padding: 16,
    marginHorizontal: 20,
    marginTop: 10,
    marginBottom: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  limitReachedBanner: {
    backgroundColor: '#fff5f5',
    borderColor: '#fc8181',
  },
  bannerText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2d3748',
    textAlign: 'center',
  },
  bannerSubtext: {
    fontSize: 12,
    color: '#718096',
    textAlign: 'center',
    marginTop: 4,
  },
  bannerHint: {
    fontSize: 11,
    color: '#4299e1',
    textAlign: 'center',
    marginTop: 6,
    fontStyle: 'italic',
  },
  limitReachedText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#c53030',
    textAlign: 'center',
    marginBottom: 4,
  },
  upgradeButton: {
    backgroundColor: '#4299e1',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    marginTop: 12,
    alignSelf: 'center',
  },
  upgradeButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
});

// Export default for backward compatibility
export default ScanLimitBanner;

