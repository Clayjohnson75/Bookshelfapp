/**
 * Bookshelf strip: fewer, bigger covers; slight overlap; ragged/jumbled, layered z.
 * Layout: CoversStrip is position absolute; each cover is position absolute with left, top, transform.
 * Do NOT use flexDirection: 'row' for covers use only absolute positioning for ragged Y.
 */
import React, { useMemo, useState, useCallback } from 'react';
import { View, Image, StyleSheet, LayoutChangeEvent, Platform } from 'react-native';
import { logger } from '../utils/logger';

// LOCKED collage cover sizing (final approved design).
const COVER_W = 72;
const COVER_H = 108;
const COVER_RADIUS = 10;
/** Slight collage overlap (about 12px at current cover width). */
const START_X = -10;
const STRIP_TOP_INSET = 8;
const STRIP_BOTTOM_INSET = 0;
const TWO_ROW_GAP = 0;
const MIN_ROW_GAP = 0;
const TWO_ROW_OVERLAP = 8;
const TARGET_ROW_H = 96;
const MIN_ROW_H = 72;
const MAX_UNIQUE = 50;
const MAX_COVERS_FILL = 24;

function hashToUnit(input: string): number {
 let hash = 5381;
 for (let i = 0; i < input.length; i++) {
 hash = ((hash << 5) + hash) + input.charCodeAt(i);
 hash |= 0;
 }
 return ((hash >>> 0) % 10000) / 10000;
}

function jitter(seedKey: string, min: number, max: number): number {
 const u = hashToUnit(seedKey);
 return min + (max - min) * u;
}

export interface HeaderShelfCollageProps {
 covers: string[];
 height?: number;
 topInset?: number;
 bottomInset?: number;
 seed?: string;
 blurRadius?: number;
 muted?: boolean;
 opacity?: number;
 twoRows?: boolean;
}

export const HeaderShelfCollage: React.FC<HeaderShelfCollageProps> = ({
 covers,
 height = 138,
 topInset = STRIP_TOP_INSET,
 bottomInset = STRIP_BOTTOM_INSET,
 seed = '',
 blurRadius = 0,
 muted = false,
 opacity = 1,
 twoRows = false,
}) => {
 const [layout, setLayout] = useState({ width: 0, height: 0 });

 const onLayout = useCallback((e: LayoutChangeEvent) => {
 const { width, height: h } = e.nativeEvent.layout;
 setLayout({ width, height: h });
 }, []);

 const stripH = height;
 const headerWidth = layout.width;

 const uniqueCovers = useMemo(() => {
 const seen = new Set<string>();
 const out: string[] = [];
 for (const uri of covers) {
 if (seen.has(uri)) continue;
 seen.add(uri);
 out.push(uri);
 if (out.length >= MAX_UNIQUE) break;
 }
 return out;
 }, [covers]);

 const stripLayout = useMemo(() => {
 if (headerWidth <= 0 || uniqueCovers.length === 0) {
 return {
 placedItems: [] as { uri: string; x: number; y: number; rot: number; ty: number; tx: number; scale: number; z: number; row: 'top' | 'bottom' }[],
 coverW: COVER_W,
 coverH: COVER_H,
 };
 }

 const coverW = COVER_W;
 const coverH = COVER_H;
 const xStep = Math.round(coverW - 12);
 const effectiveTopInset = Math.max(0, topInset);
 const effectiveBottomInset = Math.max(0, bottomInset);
 const totalInset = effectiveTopInset + effectiveBottomInset;
 const availableWithoutInset = Math.max(0, stripH - totalInset);

 let rowGap = twoRows ? TWO_ROW_GAP : 0;
 let rowHeight = TARGET_ROW_H;

 if (twoRows) {
 const minimumNeeded = MIN_ROW_H * 2 + MIN_ROW_GAP;
    if (availableWithoutInset < minimumNeeded && __DEV__) {
      logger.logOnce(
        `collage_too_short:${stripH}:${minimumNeeded}`,
        'info',
        '[HeaderShelfCollage]',
        'header too short for preferred 2-row layout',
        { height: stripH, minimumSuggested: minimumNeeded + totalInset }
      );
    }

 if (availableWithoutInset >= TARGET_ROW_H * 2 + TWO_ROW_GAP) {
 rowGap = TWO_ROW_GAP;
 rowHeight = TARGET_ROW_H;
 } else {
 rowGap = Math.max(0, Math.min(TWO_ROW_GAP, availableWithoutInset - MIN_ROW_H * 2));
 if (availableWithoutInset >= MIN_ROW_H * 2 + MIN_ROW_GAP) {
 rowGap = Math.max(rowGap, MIN_ROW_GAP);
 }
 const availableForRows = Math.max(0, availableWithoutInset - rowGap);
 rowHeight = Math.max(MIN_ROW_H, Math.floor(availableForRows / 2));
 }
 } else {
 rowGap = 0;
 rowHeight = Math.max(MIN_ROW_H, Math.min(TARGET_ROW_H, availableWithoutInset));
 }

  if (__DEV__ && coverH > rowHeight + COVER_H * 0.5) {
    // Covers intentionally overflow rowHeight — that's what creates the "books sticking up"
    // shelf aesthetic (baseRowY centers covers so they bleed equally above and below the row).
    // Only log when overflow exceeds 50% of cover height, which would indicate a genuine
    // misconfiguration (e.g. a cover taller than the entire header).
    logger.logOnce(
      `header_shelf_collage_cover_exceed_${coverH}_${rowHeight}`,
      'info',
      '[HeaderShelfCollage]',
      `cover (${coverH}px) exceeds rowHeight (${rowHeight}px) by ${coverH - rowHeight}px — check COVER_H / height prop`,
    );
  }

 // Add one buffered slot to avoid right-edge clipping from subtle jitter/scale.
 const maxPerRow = Math.max(0, Math.min(MAX_COVERS_FILL, Math.ceil((headerWidth + coverW - START_X) / xStep) + 1));
 const totalSlots = twoRows ? maxPerRow * 2 : maxPerRow;
 const visibleCovers = uniqueCovers.slice(0, totalSlots);
 const topRowCovers = visibleCovers.slice(0, maxPerRow);
 const bottomRowCovers = twoRows ? visibleCovers.slice(maxPerRow, maxPerRow * 2) : [];

 // Keep cover size/spacing; each row clips independently to prevent overlap.
 const baseRowY = Math.round((rowHeight - coverH) / 2);
 const topItems = topRowCovers.map((uri, i) => {
 const curX = START_X + i * xStep;
 const y = baseRowY;
 const seedBase = `${seed}|top|${uri}|${i}`;
 const rot = jitter(`${seedBase}:rot`, -4, 4);
 const ty = jitter(`${seedBase}:ty`, -10, 10);
 const txRaw = jitter(`${seedBase}:tx`, -4, 4);
 // Keep the last tile from drifting off the right edge.
 const tx = i === topRowCovers.length - 1 ? Math.min(0, txRaw) : txRaw;
 const scale = jitter(`${seedBase}:scale`, 0.96, 1.04);
 const z = Math.round(jitter(`${seedBase}:depth`, 0, 20));
 return { uri, x: curX, y, rot, ty, tx, scale, z };
 });

 const bottomCenterIndex = Math.floor(Math.max(0, bottomRowCovers.length - 1) / 2);
 const bottomItems = twoRows
 ? bottomRowCovers.map((uri, i) => {
 const curX = START_X + i * xStep;
 const baseY = baseRowY;
 const seedBase = `${seed}|bottom|${uri}|${i}`;
 const rot = jitter(`${seedBase}:rot`, -4, 4);
 const ty = jitter(`${seedBase}:ty`, -10, 10);
 const txRaw = jitter(`${seedBase}:tx`, -4, 4);
 // Keep the last tile from drifting off the right edge.
 const tx = i === bottomRowCovers.length - 1 ? Math.min(0, txRaw) : txRaw;
 const scale = jitter(`${seedBase}:scale`, 0.96, 1.04);
 const z = Math.round(jitter(`${seedBase}:depth`, 0, 20));
 // Make center-bottom sit visually lower and less dominant than side covers.
 const centerDrop = Math.abs(i - bottomCenterIndex) === 0 ? 8 : 0;
 const zPenalty = Math.abs(i - bottomCenterIndex) === 0 ? 70 : 0;
 return { uri, x: curX, y: baseY + centerDrop, rot, ty, tx, scale, z: Math.max(0, z - zPenalty) };
 })
 : [];

 const topRowY = effectiveTopInset;
 const bottomRowY = twoRows
 ? effectiveTopInset + rowHeight + rowGap - TWO_ROW_OVERLAP
 : effectiveTopInset;
 const topCenterIndex = Math.floor(Math.max(0, topRowCovers.length - 1) / 2);

 const placedTop = topItems.map((item, i) => ({
 ...item,
 y: topRowY + item.y,
 // Let top-middle books occasionally sit above bottom row for natural overlap.
 z: 100 + item.z + (Math.abs(i - topCenterIndex) <= 1 ? 120 : 0),
 row: 'top' as const,
 }));
 const placedBottom = bottomItems.map((item) => ({
 ...item,
 y: bottomRowY + item.y,
 z: 200 + item.z,
 row: 'bottom' as const,
 }));

 const placedItems = [...placedTop, ...placedBottom].sort((a, b) => a.z - b.z);
 return { placedItems, coverW, coverH };
 }, [headerWidth, stripH, uniqueCovers, twoRows, topInset, bottomInset, seed]);

 return (
 <View style={[styles.container, { height }]} onLayout={onLayout}>
 {/* Single absolute paint surface; overlap is controlled per-book, not per-row rectangles. */}
 <View style={[styles.stripWrap, { height }]} pointerEvents="none">
 {stripLayout.placedItems.map(({ uri, x, y, rot, ty, tx, scale, z, row }, index) => (
 <Image
 key={`row-${row}-${index}-${uri.length}`}
 source={{ uri }}
 blurRadius={blurRadius}
 style={[
 styles.coverAbsolute,
 {
 left: x,
 top: y,
 width: stripLayout.coverW,
 height: stripLayout.coverH,
 zIndex: z,
 transform: [
 { translateX: tx },
 { translateY: ty },
 { rotate: `${rot}deg` },
 { scale },
 ],
 borderRadius: COVER_RADIUS,
 opacity,
 ...(muted && Platform.OS === 'web' ? { filter: 'saturate(0.72) contrast(0.92)' as any } : {}),
 },
 ]}
 resizeMode="cover"
 />
 ))}
 </View>
 </View>
 );
};

const styles = StyleSheet.create({
 container: {
 width: '100%',
 overflow: 'visible',
 position: 'relative',
 },
 stripWrap: {
 position: 'absolute',
 left: 0,
 right: 0,
 top: 0,
 width: '100%',
 overflow: 'visible',
 },
 coverAbsolute: {
 position: 'absolute',
 overflow: 'hidden',
 borderRadius: COVER_RADIUS,
 borderWidth: 0.6,
 borderColor: 'rgba(0,0,0,0.14)',
 shadowColor: '#000',
 shadowOffset: { width: 0, height: 1 },
 shadowOpacity: 0.12,
 shadowRadius: 2.5,
 elevation: 2,
 },
});
