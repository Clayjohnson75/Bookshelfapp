/**
 * Shared tab header for Explore and My Library same height and background as Scans (canonical).
 * Uses Scans canonical token (t.colors.bg) so Profile/Explore adopt Scans style, not the other way around.
 */
import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { useResponsive } from '../lib/useResponsive';

/** Exact content height below safe area Scans canonical (slightly larger: ~82). */
export const HEADER_CONTENT_HEIGHT = 82;

export interface TabHeaderProps {
 children: React.ReactNode;
 style?: ViewStyle;
}

export function TabHeader({ children, style }: TabHeaderProps) {
 const insets = useSafeAreaInsets();
 const { t } = useTheme();
 const { isTablet } = useResponsive();
 const totalHeight = insets.top + HEADER_CONTENT_HEIGHT;
 const headerBg = t.colors.headerBg ?? t.colors.headerBackground;

 return (
 <View
 style={[
 styles.outer,
 {
 height: totalHeight,
 paddingTop: insets.top,
 paddingHorizontal: isTablet ? 32 : 20,
 backgroundColor: headerBg,
 },
 style,
 ]}
 >
 <View style={styles.inner}>
 {children}
 </View>
 </View>
 );
}

const styles = StyleSheet.create({
 outer: {
 paddingHorizontal: 20,
 paddingBottom: 22,
 marginBottom: 12,
 },
 inner: {
 flex: 1,
 width: '100%',
 maxWidth: 900,
 alignSelf: 'center',
 },
});
