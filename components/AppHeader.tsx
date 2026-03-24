import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronBackIcon } from './ChevronBackIcon';
import { useTheme } from '../theme/ThemeProvider';
import { HEADER_CONTENT_HEIGHT } from './TabHeader';
import { useResponsive } from '../lib/useResponsive';

type AppHeaderProps = {
  title: string;
  onBack?: () => void;
  rightSlot?: React.ReactNode;
  style?: ViewStyle;
};

export function AppHeader({ title, onBack, rightSlot, style }: AppHeaderProps) {
  const insets = useSafeAreaInsets();
  const { t } = useTheme();
  const { headerTitlePadding } = useResponsive();
  const bg = t.colors.headerBg ?? t.colors.headerBackground ?? t.colors.surface ?? t.colors.bg;
  const textColor = t.colors.headerText ?? t.colors.textPrimary ?? t.colors.text;

  return (
    <View
      style={[
        styles.root,
        {
          height: insets.top + HEADER_CONTENT_HEIGHT,
          paddingTop: insets.top,
          backgroundColor: bg,
          borderBottomColor: t.colors.divider ?? t.colors.separator ?? t.colors.border,
        },
        style,
      ]}
    >
      <View style={styles.inner}>
        <View pointerEvents="none" style={[styles.titleLayer, { paddingHorizontal: headerTitlePadding }]}>
          <Text style={[styles.title, { color: textColor }]} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <View style={styles.side}>
          {onBack ? (
            <TouchableOpacity
              style={styles.backButton}
              onPress={onBack}
              activeOpacity={0.75}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <ChevronBackIcon size={24} color={t.colors.headerIcon ?? textColor} />
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={styles.side}>{rightSlot}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    justifyContent: 'flex-end',
    paddingBottom: 10,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    position: 'relative',
    minHeight: 44,
  },
  titleLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    // paddingHorizontal set dynamically via useResponsive().headerTitlePadding
  },
  side: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backButton: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 26,
    includeFontPadding: false,
    textAlignVertical: 'center',
    letterSpacing: 0.5,
  },
});

