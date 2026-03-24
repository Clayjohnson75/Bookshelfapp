import { useWindowDimensions } from 'react-native';

/**
 * Responsive layout values derived from screen width.
 * Pure function so it can be used both inside hooks and in getStyles() factories.
 */
export function getLayout(screenWidth: number) {
  const isSmallPhone = screenWidth < 380;   // iPhone SE / 8
  const isPhone = screenWidth < 768;
  const isTablet = screenWidth >= 768;
  const isLargeTablet = screenWidth >= 1024;

  // Type scale: matches the existing pattern in MyLibraryTab / ScansTab.
  const typeScale =
    screenWidth > 1000 ? 1.14 :
    screenWidth > 800  ? 1.1  :
    screenWidth > 600  ? 1.05 :
    1;

  // Book grid columns: iPad ≥900 → 6, mid >700 → 5, phone → 4.
  const bookGridColumns = screenWidth >= 900 ? 6 : screenWidth > 700 ? 5 : 4;

  // Photo grid columns: large → 3, mid → 3, phone → 2.
  const photoColumns = screenWidth > 900 ? 3 : screenWidth >= 600 ? 3 : 2;

  // Pending-scan grid: tablet → 6, phone → 4.
  const pendingGridColumns = screenWidth >= 768 ? 6 : 4;

  return {
    screenWidth,
    isSmallPhone,
    isPhone,
    isTablet,
    isLargeTablet,
    typeScale,
    bookGridColumns,
    photoColumns,
    pendingGridColumns,
    // Horizontal content padding: wider on tablet.
    horizontalPadding: isTablet ? 24 : 16,
    // AppHeader title layer padding: tighter on small phones to avoid truncation.
    headerTitlePadding: isSmallPhone ? 64 : 96,
  };
}

export type ResponsiveLayout = ReturnType<typeof getLayout>;

/**
 * Compute the width of a single grid item, accounting for padding and gaps.
 * Clamps container to maxWidth (default 900) to avoid overly wide layouts.
 */
export function getGridItemWidth(
  containerWidth: number,
  columns: number,
  horizontalPadding: number,
  gap: number,
  maxWidth = 900,
): number {
  const clamped = Math.min(containerWidth, maxWidth);
  return Math.max(
    1,
    Math.floor((clamped - horizontalPadding * 2 - gap * (columns - 1)) / columns),
  );
}

/**
 * Reactive hook — re-renders the component when screen dimensions change.
 * Preferred over Dimensions.get() + addEventListener.
 */
export function useResponsive() {
  const { width, height } = useWindowDimensions();
  const screenWidth = width || 375;
  const screenHeight = height || 667;
  return {
    screenWidth,
    screenHeight,
    ...getLayout(screenWidth),
  };
}
