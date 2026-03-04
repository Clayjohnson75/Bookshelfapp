/**
 * Theme tokens single source of truth for light and dark (Scriptorium) themes.
 * Use via useTheme() so the whole app can swap themes without per-screen redesign.
 */
export type ThemeName = 'light' | 'scriptoriumDark';

/**
 * Semantic token names use these everywhere so light/dark and future tweaks stay consistent.
 * Aliases (bg, surface, primary, etc.) remain for backward compatibility; prefer semantic names for new code.
 */
export type ThemeTokens = {
 name: ThemeName;
 colors: {
 /** Semantic: main screen/scroll background. Light: warm off-white/parchment. Dark: deep warm gray (NOT blue-gray). */
 backgroundPrimary: string;
 /** Semantic: secondary background areas. */
 backgroundSecondary: string;
 /** Semantic: cards, modals, raised surfaces. Light: slightly lighter than bg. Dark: slightly lighter warm gray. */
 surfacePrimary: string;
 /** Semantic: chips, inactive pills, inputs, scan bar. */
 surfaceSecondary: string;
 /** Semantic: primary actions, active tab, progress fill. Light: beige/book tone. Dark: muted warm tan. */
 accentPrimary: string;
 /** Semantic: primary text. Light: charcoal. Dark: near-white (not pure white). */
 textPrimary: string;
 /** Semantic: secondary text, body copy, row labels. Clearly readable in dark mode. */
 textSecondary: string;
 /** Semantic: tertiary text (rare). Slightly deemphasized vs secondary. */
 textTertiary?: string;
 /** Semantic: hints, placeholders only. Not for section labels like "Description". */
 textMuted: string;
 /** Semantic: dividers between sections. Subtle but visible in dark (~2030% opacity). */
 divider: string;
 /** Semantic: borders, subtle outlines. */
 borderSubtle: string;
 /** Input background (search, text fields). Light/dark aware. */
 inputBg?: string;
 /** Input border. Light/dark aware. */
 inputBorder?: string;
 /** Semantic: bottom tab bar background. */
 navBackground: string;
 /** Chips, secondary buttons, pill controls. Light: warm gray. Dark: elevated surface. */
 controlBg?: string;
 /** Pressed state for controlBg. */
 controlBgPressed?: string;
 /** Text on controlBg (chips, pills). */
 controlText?: string;
 /** Icon color (list chevrons, actions). Same as textSecondary. */
 icon?: string;
 /** Modals/sheets only slightly elevated over surface. */
 surfaceElevated?: string;
 /** Text on dark backgrounds (e.g. header overlay). Light theme: white; dark: near-white. */
 textOnDark?: string;

 bg: string;
 surface: string;
 surface2: string;
 /** Scans cards/tiles; slightly darker than page in light, slightly lighter in dark. Same as surface2. */
 surfaceStrong?: string;
 text: string;
 /** Alias for textMuted hints/placeholders only. */
 muted: string;
 /** Hint / tertiary text (e.g. empty state hints, placeholders). */
 textHint?: string;
 border: string;
 /** Header background, section separators. Prefer divider for visible section dividers. */
 separator: string;
 /** Design source of truth (Scans). Tab screen background. Scans, Profile, Explore use this; no per-screen overrides. */
 screenBackground: string;
 /** Same as Scans header. Profile + Explore use via TabHeader (same height HEADER_CONTENT_HEIGHT). No per-screen overrides. */
 headerBackground: string;
 /** Canonical header background for all app headers (AppHeader, TabHeader, modal headers). */
 headerBg: string;
 /** Canonical header title/text color. */
 headerText: string;
 /** Canonical header icon color. */
 headerIcon: string;
 /** Explicit light header use for headers, never theme.colors.background. */
 headerLight?: string;
 /** Explicit dark header (elevated surface). Use for headers in dark mode, never theme.colors.background. */
 headerDark?: string;
 /** Canonical screen background token alias for cross-screen consistency. */
 screenBg: string;

 primary: string; // brand gold primary CTAs, tab highlight
 primaryText: string;

 accent: string; // beige/gold primary actions, progress fill
 accentPressed?: string; // darker beige for pressed state
 accentTextOn?: string; // text on accent (e.g. buttons)
 accentSurface?: string; // lighter beige for surfaces (e.g. scan bar)
 accent2: string; // brass/amber (same as primary in light)
 /** Muted blue for links only; not for primary CTAs. */
 linkMuted?: string;
 /** Softer supporting tone: button outlines, disabled buttons, chips, pills. */
 secondary: string;
 danger: string;

 card: string;
 overlay: string;

 // book UI specifics
 pendingChipBg: string;
 pendingChipText: string;
 approvedChipBg: string;
 approvedChipText: string;
 /** Tile/card selected overlay (e.g. rgba(201,168,120,0.15) in light). */
 selectionOverlay?: string;
 /** Secondary button border (e.g. #E2E8F0 in light). */
 secondaryButtonBorder?: string;
 /** Secondary/edit button bg in dark (slightly lighter than surface2 for contrast). */
 secondaryButtonBg?: string;
 /** Secondary/edit button text in dark (slightly brighter than body text). */
 secondaryButtonText?: string;
 /** Sticky bottom action bar: frosted/translucent so it feels elevated and separate. */
 toolbarFrostedBg?: string;
 /** Selection/action tray: raised surface (light: warm cream, dark: near-charcoal). */
 surfaceRaised?: string;
 /** Selection/action tray: subtle border (light/dark). */
 borderSoft?: string;
 /** Bottom tab bar background. Light: warm cream. Dark: page bg. */
 tabBarBg?: string;
 /** Tab bar top border. Light: rgba(0,0,0,0.06). Dark: rgba(255,255,255,0.08). */
 tabBarBorderTop?: string;
 /** Tab bar: active icon/label = brand beige. */
 tabIconActive?: string;
 /** Tab bar: inactive icon/label = muted gray. */
 tabIconInactive?: string;
 /** Secondary option buttons (e.g. theme Auto/Light/Dark). Dark: visible border rgba(255,255,255,0.15). */
 themeOptionBorder?: string;
 };
 typography: {
 headingFont: string;
 bodyFont: string;
 };
};

// Light: parchment/off-white bg; surface slightly warmer (not stark white); text high contrast.
const LIGHT_THEME: ThemeTokens = {
 name: 'light',
 colors: {
 backgroundPrimary: '#F6F3EE',
 backgroundSecondary: '#F0ECE6',
 surfacePrimary: '#FAF8F5',
 surfaceSecondary: '#F0ECE6',
 accentPrimary: '#C9A878',
 textPrimary: '#1B1B1B',
 textSecondary: '#6B6B6B',
 textTertiary: '#7A756D',
 textMuted: '#9A9A9A',
 divider: '#E6E1D8',
 borderSubtle: '#E6E1D8',
 inputBg: '#F0ECE6',
 inputBorder: '#E6E1D8',
 navBackground: '#FAF8F5',
 controlBg: '#F0ECE6',
 controlBgPressed: '#E6E1D8',
 controlText: '#1B1B1B',
 icon: '#6B6B6B',
 surfaceElevated: '#FAF8F5',
 textOnDark: '#FFFFFF',

 bg: '#F6F3EE',
 surface: '#FAF8F5',
 surface2: '#F0ECE6',
 surfaceStrong: '#F0ECE6',
 text: '#1B1B1B',
 muted: '#9A9A9A',
 textHint: '#9A9A9A',
 border: '#E6E1D8',
 separator: '#ECE6DD',
 screenBackground: '#F6F3EE',
 /** Scans canonical header: slightly darker than page. Profile + Explore use same token. */
 headerBackground: '#ECE6DD',
 headerBg: '#ECE6DD',
 headerText: '#181818',
 headerIcon: '#181818',
 headerLight: '#ECE6DD',
 headerDark: '#ECE6DD',
 screenBg: '#F6F3EE',

 primary: '#C9A878',
 primaryText: '#1B1B1B',

 accent: '#C9A878',
 accentPressed: '#B8956A',
 accentTextOn: '#1B1B1B',
 accentSurface: '#E8E0D5',
 accent2: '#C9A878',
 linkMuted: '#6B7A99',
 secondary: '#DED2BF',
 danger: '#DC2626',

 card: '#FAF8F5',
 overlay: 'rgba(0,0,0,0.5)',

 pendingChipBg: '#DED2BF',
 pendingChipText: '#6B6B6B',
 approvedChipBg: '#DED2BF',
 approvedChipText: '#9A7B4F',
 selectionOverlay: 'rgba(201,168,120,0.15)',
 secondaryButtonBorder: '#DED2BF',
 toolbarFrostedBg: 'rgba(255,255,255,0.94)',
 surfaceRaised: '#E8E2D8',
 borderSoft: '#E0DBD2',
 tabBarBg: '#F7F3ED',
 tabBarBorderTop: 'rgba(0,0,0,0.06)',
 tabIconActive: '#C9A878',
 tabIconInactive: '#7A756D',
 },
 typography: {
 headingFont: 'System',
 bodyFont: 'System',
 },
};

// Card shadow: use ~0.04 opacity where cards use shadowOpacity (styling tokens only; component shadowOpacity unchanged unless you edit components).

// Dark theme: scriptorium deep warm gray (NOT blue-gray), muted warm tan accent.
// Use explicit semantic text colors (no opacity stacking on dark backgrounds).
// Cards/settings blocks use surface; page uses background keep them distinct.
const SCRIPTORIUM_DARK_THEME: ThemeTokens = {
 name: 'scriptoriumDark',
 colors: {
 backgroundPrimary: '#121413',
 backgroundSecondary: '#161918',
 surfacePrimary: '#1C1F1D',
 surfaceSecondary: '#232826',
 accentPrimary: '#C9A45C',
 textPrimary: '#E8E5DE',
 textSecondary: 'rgba(255,255,255,0.85)',
 textTertiary: 'rgba(255,255,255,0.65)',
 textMuted: 'rgba(255,255,255,0.5)',
 divider: 'rgba(255,255,255,0.22)',
 borderSubtle: 'rgba(255,255,255,0.08)',
 inputBg: '#232826',
 inputBorder: 'rgba(255,255,255,0.15)',
 navBackground: '#1C1F1D',
 controlBg: '#232826',
 controlBgPressed: '#2E3A34',
 controlText: '#E8E5DE',
 icon: 'rgba(255,255,255,0.85)',
 surfaceElevated: '#232826',
 textOnDark: '#E8E5DE',

 bg: '#121413',
 surface: '#1C1F1D',
 surface2: '#232826',
 surfaceStrong: '#232826',
 text: '#E8E5DE',
 muted: 'rgba(255,255,255,0.5)',
 textHint: 'rgba(255,255,255,0.5)',
 border: 'rgba(255,255,255,0.08)',
 separator: 'rgba(255,255,255,0.22)',
 screenBackground: '#121413',
 /** Scans canonical header. Dark: elevated surface (same as navBackground/surface) so header is distinct from page. */
 headerBackground: '#1C1F1D',
 headerBg: '#1C1F1D',
 headerText: '#E8E5DE',
 headerIcon: '#E8E5DE',
 headerLight: '#ECE6DD',
 headerDark: '#1C1F1D',
 screenBg: '#121413',

 primary: '#C9A45C',
 primaryText: '#1a1a1a',

 accent: '#C9A45C',
 accentPressed: '#A8843D',
 accentTextOn: '#1a1a1a',
 accentSurface: '#232826',
 accent2: '#C9A45C',
 linkMuted: '#9CA3AF',
 secondary: '#2E3A34',
 danger: '#c53030',

 card: '#1C1F1D',
 overlay: 'rgba(0,0,0,0.7)',

 pendingChipBg: '#2E3A34',
 pendingChipText: '#B7B1A6',
 approvedChipBg: '#232826',
 approvedChipText: '#C9A45C',
 selectionOverlay: 'rgba(201,164,92,0.15)',
 secondaryButtonBorder: '#2E3A34',
 secondaryButtonBg: '#232826',
 secondaryButtonText: '#E8E5DE',
 toolbarFrostedBg: 'rgba(28,31,29,0.94)',
 surfaceRaised: '#232826',
 borderSoft: 'rgba(255,255,255,0.08)',
 tabBarBg: '#121413',
 tabBarBorderTop: 'rgba(255,255,255,0.08)',
 tabIconActive: '#C9A45C',
 tabIconInactive: 'rgba(255,255,255,0.5)',
 themeOptionBorder: 'rgba(255,255,255,0.15)',
 },
 typography: {
 headingFont: 'System',
 bodyFont: 'System',
 },
};

export const THEMES: Record<ThemeName, ThemeTokens> = {
 light: LIGHT_THEME,
 scriptoriumDark: SCRIPTORIUM_DARK_THEME,
};

export function getTheme(name: ThemeName): ThemeTokens {
 return THEMES[name];
}
