import React, { useState, useEffect, useImperativeHandle, forwardRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../auth/SimpleAuthContext';
import { useTheme } from '../theme/ThemeProvider';
import { useResponsive } from '../lib/useResponsive';
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
 const { t } = useTheme();
 const { typeScale } = useResponsive();
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

 // FEATURE FLAG: Hide banner completely when pro is enabled for everyone
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
 style={[styles.banner, { backgroundColor: t.colors.pendingChipBg, borderColor: t.colors.border }]}
 onPress={onUpgradePress}
 activeOpacity={0.7}
 >
 <Text style={[styles.bannerText, { color: t.colors.pendingChipText, fontSize: Math.round(14 * typeScale) }]}>
 {usage.scansRemaining} scan{usage.scansRemaining !== 1 ? 's' : ''} remaining this month
 </Text>
 <Text style={[styles.bannerSubtext, { color: t.colors.textMuted, fontSize: Math.round(12 * typeScale) }]}>{formatResetDate(usage.resetAt)}</Text>
 <Text style={[styles.bannerHint, { color: t.colors.primary, fontSize: Math.round(11 * typeScale) }]}>Tap to upgrade to Pro for unlimited scans</Text>
 </TouchableOpacity>
 );
 }

 // Show upgrade prompt if limit reached
 return (
 <View style={[styles.banner, styles.limitReachedBanner, { backgroundColor: t.colors.surface2, borderColor: t.colors.danger }]}>
 <Text style={[styles.limitReachedText, { color: t.colors.danger, fontSize: Math.round(15 * typeScale) }]}>
 You've used all {usage.monthlyLimit} free scans this month
 </Text>
 <Text style={[styles.bannerSubtext, { color: t.colors.textMuted, fontSize: Math.round(12 * typeScale) }]}>{formatResetDate(usage.resetAt)}</Text>
 <TouchableOpacity style={[styles.upgradeButton, { backgroundColor: t.colors.primary }]} onPress={onUpgradePress}>
 <Text style={[styles.upgradeButtonText, { color: t.colors.primaryText }]}>Upgrade to Pro</Text>
 </TouchableOpacity>
 </View>
 );
 }
);

const styles = StyleSheet.create({
 banner: {
 padding: 16,
 marginHorizontal: 20,
 marginTop: 10,
 marginBottom: 10,
 borderRadius: 12,
 borderWidth: 1,
 },
 limitReachedBanner: {},
 bannerText: {
 fontSize: 14,
 fontWeight: '600',
 textAlign: 'center',
 },
 bannerSubtext: {
 fontSize: 12,
 textAlign: 'center',
 marginTop: 4,
 },
 bannerHint: {
 fontSize: 11,
 textAlign: 'center',
 marginTop: 6,
 fontStyle: 'italic',
 },
 limitReachedText: {
 fontSize: 15,
 fontWeight: '700',
 textAlign: 'center',
 marginBottom: 4,
 },
 upgradeButton: {
 paddingVertical: 12,
 paddingHorizontal: 24,
 borderRadius: 8,
 marginTop: 12,
 alignSelf: 'center',
 },
 upgradeButtonText: {
 fontSize: 15,
 fontWeight: '700',
 },
});

// Export default for backward compatibility
export default ScanLimitBanner;

