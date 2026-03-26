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

// ── Bar Chart Component ─────────────────────────────────────────────────────

function HorizontalBar({ label, count, maxCount, color, textColor, mutedColor }: {
  label: string; count: number; maxCount: number; color: string; textColor: string; mutedColor: string;
}) {
  const pct = maxCount > 0 ? Math.max(8, (count / maxCount) * 100) : 0;
  return (
    <View style={barStyles.row}>
      <Text style={[barStyles.label, { color: textColor }]} numberOfLines={1}>{label}</Text>
      <View style={barStyles.barTrack}>
        <View style={[barStyles.barFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      <Text style={[barStyles.count, { color: mutedColor }]}>{count}</Text>
    </View>
  );
}

const barStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 10 },
  label: { width: 100, fontSize: 13, fontWeight: '500' },
  barTrack: { flex: 1, height: 22, borderRadius: 6, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.04)' },
  barFill: { height: '100%', borderRadius: 6 },
  count: { width: 30, fontSize: 13, fontWeight: '600', textAlign: 'right' },
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
      `📚 My Bookshelf — ${stats.totalBooks} Books`,
      '',
      `📖 ${stats.totalPages.toLocaleString()} total pages${stats.avgPages ? ` (avg ${stats.avgPages})` : ''}`,
      stats.avgRating ? `⭐ ${stats.avgRating} average rating` : null,
      `✍️ ${stats.distinctAuthors} authors · 📷 ${stats.distinctPhotos} scans`,
      '',
      stats.topAuthors.length > 0 ? '🏆 Top Authors:' : null,
      ...stats.topAuthors.slice(0, 5).map((a, i) => `  ${i + 1}. ${a.key} (${a.count})`),
      stats.topCategories.length > 0 ? '\n📂 Top Categories:' : null,
      ...stats.topCategories.slice(0, 5).map(c => `  • ${c.key} (${c.count})`),
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
      {/* Hero stats row */}
      <View style={s.heroRow}>
        <View style={[s.heroCard, { backgroundColor: c.surface }]}>
          <Text style={[s.heroNumber, { color: c.text }]}>{stats.totalBooks}</Text>
          <Text style={[s.heroLabel, { color: c.textMuted }]}>Books</Text>
        </View>
        <View style={[s.heroCard, { backgroundColor: c.surface }]}>
          <Text style={[s.heroNumber, { color: c.text }]}>{stats.totalPages.toLocaleString()}</Text>
          <Text style={[s.heroLabel, { color: c.textMuted }]}>Pages</Text>
        </View>
        <View style={[s.heroCard, { backgroundColor: c.surface }]}>
          <Text style={[s.heroNumber, { color: c.text }]}>{stats.distinctAuthors}</Text>
          <Text style={[s.heroLabel, { color: c.textMuted }]}>Authors</Text>
        </View>
      </View>

      {/* Secondary stats */}
      <View style={s.secondaryRow}>
        {stats.avgRating && (
          <View style={[s.secondaryCard, { backgroundColor: c.surface }]}>
            <Text style={[s.secondaryNumber, { color: c.text }]}>{'⭐'} {stats.avgRating}</Text>
            <Text style={[s.secondaryLabel, { color: c.textMuted }]}>Avg Rating</Text>
          </View>
        )}
        <View style={[s.secondaryCard, { backgroundColor: c.surface }]}>
          <Text style={[s.secondaryNumber, { color: c.text }]}>{stats.avgPages || '—'}</Text>
          <Text style={[s.secondaryLabel, { color: c.textMuted }]}>Avg Pages</Text>
        </View>
        <View style={[s.secondaryCard, { backgroundColor: c.surface }]}>
          <Text style={[s.secondaryNumber, { color: c.text }]}>{stats.distinctPhotos}</Text>
          <Text style={[s.secondaryLabel, { color: c.textMuted }]}>Scans</Text>
        </View>
      </View>

      {/* Top Authors */}
      {stats.topAuthors.length > 0 && (
        <View style={[s.section, { backgroundColor: c.surface }]}>
          <Text style={[s.sectionTitle, { color: c.text }]}>Top Authors</Text>
          {stats.topAuthors.map(a => (
            <HorizontalBar
              key={a.key}
              label={a.key}
              count={a.count}
              maxCount={stats.topAuthors[0].count}
              color={accent}
              textColor={c.text ?? '#1B1B1B'}
              mutedColor={c.textMuted ?? '#9A9A9A'}
            />
          ))}
        </View>
      )}

      {/* Top Categories */}
      {stats.topCategories.length > 0 && (
        <View style={[s.section, { backgroundColor: c.surface }]}>
          <Text style={[s.sectionTitle, { color: c.text }]}>Categories</Text>
          {stats.topCategories.map(cat => (
            <HorizontalBar
              key={cat.key}
              label={cat.key}
              count={cat.count}
              maxCount={stats.topCategories[0].count}
              color={accent}
              textColor={c.text ?? '#1B1B1B'}
              mutedColor={c.textMuted ?? '#9A9A9A'}
            />
          ))}
        </View>
      )}

      {/* By Decade */}
      {stats.decades.length > 0 && (
        <View style={[s.section, { backgroundColor: c.surface }]}>
          <Text style={[s.sectionTitle, { color: c.text }]}>By Decade Published</Text>
          {stats.decades.map(d => (
            <HorizontalBar
              key={d.key}
              label={d.key}
              count={d.count}
              maxCount={Math.max(...stats.decades.map(x => x.count))}
              color={accent}
              textColor={c.text ?? '#1B1B1B'}
              mutedColor={c.textMuted ?? '#9A9A9A'}
            />
          ))}
        </View>
      )}

      {/* Languages & Publishers */}
      <View style={s.splitRow}>
        {stats.languages.length > 0 && (
          <View style={[s.splitCard, { backgroundColor: c.surface }]}>
            <Text style={[s.sectionTitle, { color: c.text }]}>Languages</Text>
            {stats.languages.map(l => (
              <View key={l.key} style={s.chipRow}>
                <Text style={[s.chipLabel, { color: c.text }]}>{l.key}</Text>
                <Text style={[s.chipCount, { color: c.textMuted }]}>{l.count}</Text>
              </View>
            ))}
          </View>
        )}
        {stats.topPublishers.length > 0 && (
          <View style={[s.splitCard, { backgroundColor: c.surface }]}>
            <Text style={[s.sectionTitle, { color: c.text }]}>Top Publishers</Text>
            {stats.topPublishers.slice(0, 4).map(p => (
              <View key={p.key} style={s.chipRow}>
                <Text style={[s.chipLabel, { color: c.text }]} numberOfLines={1}>{p.key}</Text>
                <Text style={[s.chipCount, { color: c.textMuted }]}>{p.count}</Text>
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
    gap: 14,
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
  heroRow: {
    flexDirection: 'row',
    gap: 10,
  },
  heroCard: {
    flex: 1,
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
  },
  heroNumber: {
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  heroLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  secondaryCard: {
    flex: 1,
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
  },
  secondaryNumber: {
    fontSize: 20,
    fontWeight: '700',
  },
  secondaryLabel: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  section: {
    borderRadius: 16,
    padding: 18,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 14,
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
    paddingVertical: 4,
  },
  chipLabel: {
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  chipCount: {
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 8,
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
