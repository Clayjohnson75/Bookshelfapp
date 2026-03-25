/**
 * Reusable row card: left CoverStack (up to 3 covers), center text (title + subtext/count), right chevron.
 * Used for Authors list and other entity lists. Themed; tap feedback via slight opacity.
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable, Image } from 'react-native';
import { PersonOutlineIcon, ChevronForwardIcon } from '../components/Icons';
import { useTheme } from '../theme/ThemeProvider';
import { useResponsive } from '../lib/useResponsive';

const COVER_SIZE = 36;
const COVER_OVERLAP = -8;

export interface EntityRowCardProps {
  title: string;
  subtext?: string;
  coverUris?: (string | undefined | null)[];
  onPress: () => void;
  testID?: string;
}

export function EntityRowCard({ title, subtext, coverUris = [], onPress, testID }: EntityRowCardProps) {
  const { t } = useTheme();
  const { typeScale } = useResponsive();
  const c = t.colors;
  const displayUris = (coverUris.filter((u): u is string => Boolean(u)) as string[]).slice(0, 3);

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          borderBottomColor: c.divider ?? c.border,
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      <View style={styles.coverStack}>
        {displayUris.length > 0 ? (
          displayUris.map((uri, idx) => (
            <View
              key={`${uri}-${idx}`}
              style={[
                styles.coverWrap,
                {
                  marginLeft: idx === 0 ? 0 : COVER_OVERLAP,
                  backgroundColor: c.surface2 ?? c.surface,
                  borderColor: c.bg,
                  borderWidth: 1.5,
                  zIndex: displayUris.length - idx,
                },
              ]}
            >
              <Image source={{ uri }} style={styles.cover} resizeMode="cover" />
            </View>
          ))
        ) : (
          <View style={[styles.coverWrap, { backgroundColor: c.surface2 ?? c.surface }]}>
            <PersonOutlineIcon size={18} color={c.textMuted} />
          </View>
        )}
      </View>
      <View style={styles.textBlock}>
        <Text style={[styles.title, { color: c.textPrimary ?? c.text, fontSize: Math.round(15 * typeScale) }]} numberOfLines={1}>
          {title}
        </Text>
        {subtext ? (
          <Text style={[styles.subtext, { color: c.textSecondary ?? c.textMuted, fontSize: Math.round(13 * typeScale) }]} numberOfLines={1}>
            {subtext}
          </Text>
        ) : null}
      </View>
      <ChevronForwardIcon size={18} color={c.textMuted} style={styles.chevron} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 52,
  },
  coverStack: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 12,
  },
  coverWrap: {
    width: COVER_SIZE,
    height: COVER_SIZE,
    borderRadius: 6,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  cover: {
    width: '100%',
    height: '100%',
  },
  textBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
  subtext: {
    fontSize: 13,
    marginTop: 1,
    fontWeight: '400',
  },
  chevron: {
    marginLeft: 8,
  },
});
