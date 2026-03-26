/**
 * Library Stats/Insights view — shown in the Stats modal on MyLibraryTab.
 * Pure presentational: receives books array, computes all stats locally.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, Share, Platform } from 'react-native';
import { TouchableOpacity } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import type { Book } from '../types/BookTypes';

interface StatsViewProps {
  books: Book[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDecade(dateStr?: string | null): string | null {
  if (!dateStr) return null;
  const match = dateStr.match(/(\d{4})/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  if (isNaN(year) || year < 1400 || year > 2100) return null;
  const decade = Math.floor(year / 10) * 10;
  return `${decade}s`;
}

function topN<T>(items: T[], keyFn: (item: T) => string | null, n: number): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  items.forEach(item => {
    const key = keyFn(item);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 10000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

// ── Bar Chart Component ─────────────────────────────────────────────────────

function HorizontalBar({ label, count, maxCount, color, textColor, mutedColor, rank }: {
  label: string; count: number; maxCount: number; color: string; textColor: string; mutedColor: string; rank: number;
}) {
  const pct = maxCount > 0 ? Math.max(10, (count / maxCount) * 100) : 0;
  // Fade opacity for lower-ranked items
  const opacity = Math.max(0.35, 1 - (rank * 0.08));
  return (
    <View style={barStyles.row}>
      <Text style={[barStyles.label, { color: textColor }]} numberOfLines={1}>{label}</Text>
      <View style={barStyles.barTrack}>
        <View style={[barStyles.barFill, { width: `${pct}%`, backgroundColor: color, opacity }]} />
      </View>
      <Text style={[barStyles.count, { color: mutedColor }]}>{count}</Text>
    </View>
  );
}

const barStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 10 },
  label: { width: 110, fontSize: 13, fontWeight: '500' },
  barTrack: { flex: 1, height: 24, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.04)' },
  barFill: { height: '100%', borderRadius: 8 },
  count: { width: 30, fontSize: 13, fontWeight: '700', textAlign: 'right' },
});

// ── Main Component ──────────────────────────────────────────────────────────

export function StatsView({ books }: StatsViewProps) {
  const { t } = useTheme();

  const stats = useMemo(() => {
    const approved = books.filter(b => (b as any).status === 'approved' && !(b as any).deleted_at);

    const totalBooks = approved.length;
    const totalPages = approved.reduce((sum, b) => sum + ((b as any).pageCount ?? 0), 0);
    const booksWithPages = approved.filter(b => (b as any).pageCount > 0);
    const avgPages = booksWithPages.length > 0 ? Math.round(totalPages / booksWithPages.length) : 0;

    const booksWithRating = approved.filter(b => typeof (b as any).averageRating === 'number' && (b as any).averageRating > 0);
    const avgRating = booksWithRating.length > 0
      ? (booksWithRating.reduce((sum, b) => sum + ((b as any).averageRating ?? 0), 0) / booksWithRating.length).toFixed(1)
      : null;

    const readCount = approved.filter(b => (b as any).readAt).length;
    const distinctAuthors = new Set(approved.map(b => (b.author ?? '').trim().toLowerCase()).filter(Boolean)).size;
    const distinctPhotos = new Set(approved.map(b => (b as any).source_photo_id).filter(Boolean)).size;

    // Top lists
    const topAuthors = topN(approved, b => b.author?.trim() || null, 8);
    const topCategories = topN(
      approved.flatMap(b => {
        const cats = (b as any).categories;
        return Array.isArray(cats) ? cats.map((c: string) => ({ cat: c })) : [];
      }),
      item => (item as any).cat,
      8
    );
    const topPublishers = topN(approved, b => (b as any).publisher?.trim() || null, 6);
    const decades = topN(approved, b => getDecade((b as any).publishedDate), 8)
      .sort((a, b) => a.key.localeCompare(b.key));

    // Languages
    const languages = topN(approved, b => {
      const lang = (b as any).language;
      if (!lang || lang === 'unknown') return null;
      return lang === 'en' ? 'English' : lang === 'fr' ? 'French' : lang === 'es' ? 'Spanish'
        : lang === 'de' ? 'German' : lang === 'it' ? 'Italian' : lang === 'pt' ? 'Portuguese'
        : lang === 'ja' ? 'Japanese' : lang === 'zh' ? 'Chinese' : lang;
    }, 6);

    return {
      totalBooks, totalPages, avgPages, avgRating,
      readCount, distinctAuthors, distinctPhotos,
      topAuthors, topCategories, topPublishers, decades, languages,
    };
  }, [books]);

  const c = t.colors;
  const accent = c.primary ?? c.accentPrimary ?? '#C9A878';

  const handleShare = async () => {
    const lines = [
      `My Bookshelf — ${stats.totalBooks} Books`,
      '',
      `${stats.totalPages.toLocaleString()} total pages${stats.avgPages ? ` (avg ${stats.avgPages})` : ''}`,
      stats.avgRating ? `${stats.avgRating} average rating` : null,
      `${stats.distinctAuthors} authors`,
      '',
      stats.topAuthors.length > 0 ? 'Top Authors:' : null,
      ...stats.topAuthors.slice(0, 5).map((a, i) => `  ${i + 1}. ${a.key} (${a.count})`),
      stats.topCategories.length > 0 ? '\nTop Categories:' : null,
      ...stats.topCategories.slice(0, 5).map(c => `  ${c.key} (${c.count})`),
      '',
      '— Bookshelf Scanner',
    ].filter(Boolean).join('\n');

    try {
      await Share.share({
        message: lines,
        ...(Platform.OS === 'ios' ? { title: 'My Library Stats' } : {}),
      });
    } catch {}
  };

  if (stats.totalBooks === 0) {
    return (
      <View style={[s.emptyContainer, { backgroundColor: c.bg }]}>
        <Text style={[s.emptyTitle, { color: c.text }]}>No stats yet</Text>
        <Text style={[s.emptySubtext, { color: c.textMuted }]}>
          Scan some bookshelves and approve books to see your library insights.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={s.container}
      showsVerticalScrollIndicator={false}
    >
      {/* Hero stat — Books count prominently */}
      <View style={[s.heroSection, { backgroundColor: c.surface }]}>
        <Text style={[s.heroNumber, { color: c.text }]}>{stats.totalBooks}</Text>
        <Text style={[s.heroLabel, { color: c.textMuted }]}>Books in Your Library</Text>
      </View>

      {/* Key metrics row */}
      <View style={s.metricsRow}>
        <View style={[s.metricCard, { backgroundColor: c.surface }]}>
          <Text style={[s.metricValue, { color: c.text }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
            {formatNumber(stats.totalPages)}
          </Text>
          <View style={[s.metricPill, { backgroundColor: accent + '18' }]}>
            <Text style={[s.metricPillText, { color: accent }]}>Pages</Text>
          </View>
        </View>
        <View style={[s.metricCard, { backgroundColor: c.surface }]}>
          <Text style={[s.metricValue, { color: c.text }]}>{stats.distinctAuthors}</Text>
          <View style={[s.metricPill, { backgroundColor: accent + '18' }]}>
            <Text style={[s.metricPillText, { color: accent }]}>Authors</Text>
          </View>
        </View>
        <View style={[s.metricCard, { backgroundColor: c.surface }]}>
          <Text style={[s.metricValue, { color: c.text }]}>{stats.distinctPhotos}</Text>
          <View style={[s.metricPill, { backgroundColor: accent + '18' }]}>
            <Text style={[s.metricPillText, { color: accent }]}>Scans</Text>
          </View>
        </View>
      </View>

      {/* Secondary metrics */}
      <View style={s.metricsRow}>
        {stats.avgRating && (
          <View style={[s.miniCard, { backgroundColor: c.surface }]}>
            <Text style={[s.miniValue, { color: c.text }]}>{stats.avgRating}</Text>
            <Text style={[s.miniLabel, { color: c.textMuted }]}>Avg Rating</Text>
          </View>
        )}
        <View style={[s.miniCard, { backgroundColor: c.surface }]}>
          <Text style={[s.miniValue, { color: c.text }]}>{stats.avgPages || '—'}</Text>
          <Text style={[s.miniLabel, { color: c.textMuted }]}>Avg Pages</Text>
        </View>
      </View>

      {/* Top Authors */}
      {stats.topAuthors.length > 0 && (
        <View style={[s.section, { backgroundColor: c.surface }]}>
          <Text style={[s.sectionTitle, { color: c.text }]}>Top Authors</Text>
          {stats.topAuthors.map((a, i) => (
            <HorizontalBar
              key={a.key}
              label={a.key}
              count={a.count}
              maxCount={stats.topAuthors[0].count}
              color={accent}
              textColor={c.text ?? '#1B1B1B'}
              mutedColor={c.textMuted ?? '#9A9A9A'}
              rank={i}
            />
          ))}
        </View>
      )}

      {/* Top Categories */}
      {stats.topCategories.length > 0 && (
        <View style={[s.section, { backgroundColor: c.surface }]}>
          <Text style={[s.sectionTitle, { color: c.text }]}>Categories</Text>
          {stats.topCategories.map((cat, i) => (
            <HorizontalBar
              key={cat.key}
              label={cat.key}
              count={cat.count}
              maxCount={stats.topCategories[0].count}
              color={accent}
              textColor={c.text ?? '#1B1B1B'}
              mutedColor={c.textMuted ?? '#9A9A9A'}
              rank={i}
            />
          ))}
        </View>
      )}

      {/* By Decade */}
      {stats.decades.length > 0 && (
        <View style={[s.section, { backgroundColor: c.surface }]}>
          <Text style={[s.sectionTitle, { color: c.text }]}>By Decade Published</Text>
          {stats.decades.map((d, i) => (
            <HorizontalBar
              key={d.key}
              label={d.key}
              count={d.count}
              maxCount={Math.max(...stats.decades.map(x => x.count))}
              color={accent}
              textColor={c.text ?? '#1B1B1B'}
              mutedColor={c.textMuted ?? '#9A9A9A'}
              rank={i}
            />
          ))}
        </View>
      )}

      {/* Languages & Publishers side by side */}
      <View style={s.splitRow}>
        {stats.languages.length > 0 && (
          <View style={[s.splitCard, { backgroundColor: c.surface }]}>
            <Text style={[s.sectionTitle, { color: c.text }]}>Languages</Text>
            {stats.languages.map(l => (
              <View key={l.key} style={s.chipRow}>
                <Text style={[s.chipLabel, { color: c.text }]}>{l.key}</Text>
                <View style={[s.chipBadge, { backgroundColor: accent + '20' }]}>
                  <Text style={[s.chipBadgeText, { color: accent }]}>{l.count}</Text>
                </View>
              </View>
            ))}
          </View>
        )}
        {stats.topPublishers.length > 0 && (
          <View style={[s.splitCard, { backgroundColor: c.surface }]}>
            <Text style={[s.sectionTitle, { color: c.text }]}>Publishers</Text>
            {stats.topPublishers.slice(0, 4).map(p => (
              <View key={p.key} style={s.chipRow}>
                <Text style={[s.chipLabel, { color: c.text }]} numberOfLines={1}>{p.key}</Text>
                <View style={[s.chipBadge, { backgroundColor: accent + '20' }]}>
                  <Text style={[s.chipBadgeText, { color: accent }]}>{p.count}</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* Share Button */}
      <TouchableOpacity
        style={[s.shareButton, { backgroundColor: accent }]}
        onPress={handleShare}
        activeOpacity={0.8}
      >
        <Text style={s.shareButtonText}>Share My Stats</Text>
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: {
    padding: 16,
    gap: 12,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  heroSection: {
    borderRadius: 20,
    paddingVertical: 28,
    paddingHorizontal: 20,
    alignItems: 'center',
    gap: 4,
  },
  heroNumber: {
    fontSize: 56,
    fontWeight: '800',
    letterSpacing: -2,
  },
  heroLabel: {
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  metricCard: {
    flex: 1,
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 12,
    alignItems: 'center',
    gap: 8,
  },
  metricValue: {
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  metricPill: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
  },
  metricPillText: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  miniCard: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    gap: 2,
  },
  miniValue: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  miniLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  section: {
    borderRadius: 16,
    padding: 18,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 14,
    letterSpacing: 0.2,
  },
  splitRow: {
    flexDirection: 'row',
    gap: 10,
  },
  splitCard: {
    flex: 1,
    borderRadius: 16,
    padding: 16,
  },
  chipRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 5,
  },
  chipLabel: {
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  chipBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 8,
  },
  chipBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  shareButton: {
    height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  shareButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
