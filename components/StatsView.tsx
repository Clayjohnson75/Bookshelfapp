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

// ── Thin Divider ────────────────────────────────────────────────────────────

function Divider({ color }: { color: string }) {
  return <View style={[s.divider, { backgroundColor: color }]} />;
}

// ── Bar Chart Row ───────────────────────────────────────────────────────────

function HorizontalBar({ label, count, maxCount, color, textColor, mutedColor, rank }: {
  label: string; count: number; maxCount: number; color: string; textColor: string; mutedColor: string; rank: number;
}) {
  const pct = maxCount > 0 ? Math.max(8, (count / maxCount) * 100) : 0;
  const opacity = Math.max(0.3, 1 - (rank * 0.09));
  return (
    <View style={barS.row}>
      <Text style={[barS.label, { color: textColor }]} numberOfLines={1}>{label}</Text>
      <View style={barS.track}>
        <View style={[barS.fill, { width: `${pct}%`, backgroundColor: color, opacity }]} />
      </View>
      <Text style={[barS.count, { color: mutedColor }]}>{count}</Text>
    </View>
  );
}

const barS = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 10 },
  label: { width: 110, fontSize: 14, fontWeight: '400' },
  track: { flex: 1, height: 20, borderRadius: 4, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.04)' },
  fill: { height: '100%', borderRadius: 4 },
  count: { width: 28, fontSize: 14, fontWeight: '500', textAlign: 'right' },
});

// ── List Row (for Languages / Publishers) ───────────────────────────────────

function ListRow({ label, value, textColor, mutedColor, isLast, dividerColor }: {
  label: string; value: number; textColor: string; mutedColor: string; isLast: boolean; dividerColor: string;
}) {
  return (
    <>
      <View style={s.listRow}>
        <Text style={[s.listLabel, { color: textColor }]} numberOfLines={1}>{label}</Text>
        <Text style={[s.listValue, { color: mutedColor }]}>{value}</Text>
      </View>
      {!isLast && <View style={[s.listDivider, { backgroundColor: dividerColor }]} />}
    </>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export function StatsView({ books }: StatsViewProps) {
  const { t, headingFont } = useTheme();

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
  const divColor = c.border ?? (c.textMuted + '30') ?? 'rgba(0,0,0,0.08)';

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
        <Text style={[s.emptyTitle, { color: c.text, fontFamily: headingFont }]}>No stats yet</Text>
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
      {/* Hero — large book count */}
      <View style={s.heroSection}>
        <Text style={[s.heroNumber, { color: c.text, fontFamily: headingFont }]}>{stats.totalBooks}</Text>
        <Text style={[s.heroCaption, { color: c.textMuted }]}>books in your library</Text>
      </View>

      <Divider color={divColor} />

      {/* Key figures — clean row with thin vertical separators */}
      <View style={s.figuresRow}>
        <View style={s.figure}>
          <Text style={[s.figureNumber, { color: c.text }]}>{formatNumber(stats.totalPages)}</Text>
          <Text style={[s.figureCaption, { color: c.textMuted }]}>pages</Text>
        </View>
        <View style={[s.figureSep, { backgroundColor: divColor }]} />
        <View style={s.figure}>
          <Text style={[s.figureNumber, { color: c.text }]}>{stats.distinctAuthors}</Text>
          <Text style={[s.figureCaption, { color: c.textMuted }]}>authors</Text>
        </View>
        <View style={[s.figureSep, { backgroundColor: divColor }]} />
        <View style={s.figure}>
          <Text style={[s.figureNumber, { color: c.text }]}>{stats.distinctPhotos}</Text>
          <Text style={[s.figureCaption, { color: c.textMuted }]}>scans</Text>
        </View>
        {stats.avgPages > 0 && (
          <>
            <View style={[s.figureSep, { backgroundColor: divColor }]} />
            <View style={s.figure}>
              <Text style={[s.figureNumber, { color: c.text }]}>{stats.avgPages}</Text>
              <Text style={[s.figureCaption, { color: c.textMuted }]}>avg pages</Text>
            </View>
          </>
        )}
      </View>

      <Divider color={divColor} />

      {/* Top Authors */}
      {stats.topAuthors.length > 0 && (
        <View style={s.section}>
          <Text style={[s.sectionTitle, { color: c.text, fontFamily: headingFont }]}>Top Authors</Text>
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

      {/* Categories */}
      {stats.topCategories.length > 0 && (
        <>
          <Divider color={divColor} />
          <View style={s.section}>
            <Text style={[s.sectionTitle, { color: c.text, fontFamily: headingFont }]}>Categories</Text>
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
        </>
      )}

      {/* By Decade */}
      {stats.decades.length > 0 && (
        <>
          <Divider color={divColor} />
          <View style={s.section}>
            <Text style={[s.sectionTitle, { color: c.text, fontFamily: headingFont }]}>By Decade</Text>
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
        </>
      )}

      {/* Languages & Publishers — simple lists side by side */}
      {(stats.languages.length > 0 || stats.topPublishers.length > 0) && (
        <>
          <Divider color={divColor} />
          <View style={s.splitRow}>
            {stats.languages.length > 0 && (
              <View style={s.splitCol}>
                <Text style={[s.sectionTitle, { color: c.text, fontFamily: headingFont }]}>Languages</Text>
                {stats.languages.map((l, i) => (
                  <ListRow
                    key={l.key}
                    label={l.key}
                    value={l.count}
                    textColor={c.text ?? '#1B1B1B'}
                    mutedColor={c.textMuted ?? '#9A9A9A'}
                    isLast={i === stats.languages.length - 1}
                    dividerColor={divColor}
                  />
                ))}
              </View>
            )}
            {stats.topPublishers.length > 0 && (
              <View style={s.splitCol}>
                <Text style={[s.sectionTitle, { color: c.text, fontFamily: headingFont }]}>Publishers</Text>
                {stats.topPublishers.slice(0, 5).map((p, i, arr) => (
                  <ListRow
                    key={p.key}
                    label={p.key}
                    value={p.count}
                    textColor={c.text ?? '#1B1B1B'}
                    mutedColor={c.textMuted ?? '#9A9A9A'}
                    isLast={i === arr.length - 1}
                    dividerColor={divColor}
                  />
                ))}
              </View>
            )}
          </View>
        </>
      )}

      {/* Share */}
      <View style={s.shareRow}>
        <Divider color={divColor} />
        <TouchableOpacity
          style={[s.shareButton, { borderColor: accent }]}
          onPress={handleShare}
          activeOpacity={0.7}
        >
          <Text style={[s.shareButtonText, { color: accent }]}>Share My Stats</Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: {
    paddingHorizontal: 24,
    paddingTop: 8,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },

  // Hero
  heroSection: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  heroNumber: {
    fontSize: 64,
    fontWeight: '300',
    letterSpacing: -3,
    lineHeight: 70,
  },
  heroCaption: {
    fontSize: 15,
    fontWeight: '400',
    marginTop: 4,
    letterSpacing: 0.3,
  },

  // Divider
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 4,
  },

  // Figures row
  figuresRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
  },
  figure: {
    flex: 1,
    alignItems: 'center',
  },
  figureNumber: {
    fontSize: 22,
    fontWeight: '600',
    letterSpacing: -0.5,
  },
  figureCaption: {
    fontSize: 11,
    fontWeight: '400',
    marginTop: 2,
    letterSpacing: 0.2,
  },
  figureSep: {
    width: StyleSheet.hairlineWidth,
    height: 28,
  },

  // Sections
  section: {
    paddingVertical: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 14,
    letterSpacing: -0.2,
  },

  // Split columns
  splitRow: {
    flexDirection: 'row',
    gap: 24,
    paddingVertical: 16,
  },
  splitCol: {
    flex: 1,
  },

  // List rows
  listRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 7,
  },
  listLabel: {
    fontSize: 14,
    fontWeight: '400',
    flex: 1,
  },
  listValue: {
    fontSize: 14,
    fontWeight: '500',
    marginLeft: 8,
  },
  listDivider: {
    height: StyleSheet.hairlineWidth,
  },

  // Share
  shareRow: {
    marginTop: 8,
  },
  shareButton: {
    height: 48,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
  },
  shareButtonText: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});
