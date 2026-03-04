/**
 * Reusable row card: left CoverStack (up to 3 covers), center text (title + subtext/count), right chevron.
 * Used for Authors list and other entity lists. Themed; tap feedback via slight opacity/surface change.
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable, Image } from 'react-native';
import { PersonOutlineIcon, ChevronForwardIcon } from '../components/Icons';
import { useTheme } from '../theme/ThemeProvider';

const COVER_SIZE = 40;
const COVER_OVERLAP = -10;
const CARD_RADIUS = 15;
const CARD_GAP = 10;

export interface EntityRowCardProps {
  /** Main line (e.g. author name). Uses textPrimary, semibold. */
  title: string;
  /** Secondary line or count (e.g. "5 books"). Uses textSecondary or small pill. */
  subtext?: string;
  /** Up to 3 cover image URIs; rendered as stacked thumbnails on the left. */
  coverUris?: (string | undefined | null)[];
  onPress: () => void;
  /** Optional testID for E2E. */
  testID?: string;
}

export function EntityRowCard({ title, subtext, coverUris = [], onPress, testID }: EntityRowCardProps) {
  const { t } = useTheme();
  const c = t.colors;
  const displayUris = (coverUris.filter((u): u is string => Boolean(u)) as string[]).slice(0, 3);

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: pressed ? (c.surface2 ?? c.surface) : c.surface,
          borderColor: c.border,
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
                  borderColor: c.surface,
                  borderWidth: 1.5,
                  zIndex: displayUris.length - idx,
                },
              ]}
            >
              <Image source={{ uri }} style={styles.cover} resizeMode="cover" />
            </View>
          ))
        ) : (
          <View style={[styles.coverWrap, styles.coverPlaceholder, { backgroundColor: c.surface2 ?? c.surface }]}>
            <PersonOutlineIcon size={20} color={c.textMuted} />
          </View>
        )}
      </View>
      <View style={styles.textBlock}>
        <Text style={[styles.title, { color: c.textPrimary ?? c.text }]} numberOfLines={1}>
          {title}
        </Text>
        {subtext ? (
          <Text style={[styles.subtext, { color: c.textSecondary ?? c.textMuted }]} numberOfLines={1}>
            {subtext}
          </Text>
        ) : null}
      </View>
      <ChevronForwardIcon size={20} color={c.textSecondary ?? c.textMuted} style={styles.chevron} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: CARD_RADIUS,
    borderWidth: 1,
    marginBottom: CARD_GAP,
    minHeight: 56,
  },
  coverStack: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 14,
  },
  coverWrap: {
    width: COVER_SIZE,
    height: COVER_SIZE,
    borderRadius: 8,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  cover: {
    width: '100%',
    height: '100%',
  },
  coverPlaceholder: {},
  textBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  subtext: {
    fontSize: 13,
    marginTop: 2,
    fontWeight: '500',
  },
  chevron: {
    marginLeft: 8,
  },
});
