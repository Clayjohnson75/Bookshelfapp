import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useAuth } from '../auth/SimpleAuthContext';
import { getUserScanUsage, formatResetDate, ScanUsage } from '../services/subscriptionService';

interface ScanLimitBannerProps {
  onUpgradePress: () => void;
}

export const ScanLimitBanner: React.FC<ScanLimitBannerProps> = ({ onUpgradePress }) => {
  const { user } = useAuth();
  const [usage, setUsage] = useState<ScanUsage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user) {
      loadUsage();
    }
  }, [user]);

  const loadUsage = async () => {
    if (!user) return;
    
    setLoading(true);
    const scanUsage = await getUserScanUsage(user.uid);
    setUsage(scanUsage);
    setLoading(false);
  };

  if (loading || !usage) {
    return null;
  }

  // Don't show banner for pro or owner users
  if (usage.subscriptionTier === 'pro' || usage.subscriptionTier === 'owner') {
    return null;
  }

  // Don't show if unlimited scans remaining
  if (usage.scansRemaining === null || usage.scansRemaining > 0) {
    return (
      <View style={styles.banner}>
        <Text style={styles.bannerText}>
          {usage.scansRemaining} scan{usage.scansRemaining !== 1 ? 's' : ''} remaining this month
        </Text>
        <Text style={styles.bannerSubtext}>{formatResetDate(usage.resetAt)}</Text>
      </View>
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
};

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

