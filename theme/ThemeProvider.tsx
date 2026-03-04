/**
 * Theme provider + hook. Single source of truth for appearance.
 * Theme is auth-independent: preference stored in AsyncStorage and applies
 * before sign-in (guest scan / sign-in flows unchanged).
 * Stores themePreference: 'system' | 'light' | 'dark'. Resolves: dark → scriptoriumDark.
 *
 * Auto ('system') mode: switches on the hour, not via OS appearance setting.
 *   Light: 7:00 AM – 8:00 PM
 *   Dark:  8:00 PM – 7:00 AM
 * A per-minute interval keeps the resolved theme in sync.
 *
 * useTheme() → { t, setPreference, preference, headingFont }
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFonts } from '@expo-google-fonts/playfair-display/useFonts';
import { PlayfairDisplay_400Regular } from '@expo-google-fonts/playfair-display';
import Ionicons from '@expo/vector-icons/Ionicons';
import { getTheme, type ThemeTokens } from './tokens';

export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_PREFERENCE_KEY = 'theme_preference';

/** System serif fallback for headings when custom font not yet loaded (iOS: Georgia). */
const HEADING_FALLBACK = Platform.select({ ios: 'Georgia', default: 'serif' });

/**
 * Returns 'dark' if the current local hour is in the night/evening window.
 * Light: 07:00–20:00  |  Dark: 20:00–07:00
 */
function timeBasedScheme(): 'light' | 'dark' {
  const hour = new Date().getHours(); // 0–23 local time
  return hour >= 7 && hour < 20 ? 'light' : 'dark';
}

function resolveTheme(preference: ThemePreference, autoScheme: 'light' | 'dark'): ThemeTokens {
  if (preference === 'light') return getTheme('light');
  if (preference === 'dark') return getTheme('scriptoriumDark');
  // Auto: time-of-day based, not OS appearance setting.
  return autoScheme === 'dark' ? getTheme('scriptoriumDark') : getTheme('light');
}

export interface ThemeContextValue {
  t: ThemeTokens;
  preference: ThemePreference;
  setPreference: (pref: ThemePreference) => Promise<void>;
  /** Font family for headings (titles, section headers). Playfair when loaded, else system serif. */
  headingFont: string;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  // Time-based auto scheme; re-evaluated every minute so transitions are seamless.
  const [autoScheme, setAutoScheme] = useState<'light' | 'dark'>(() => timeBasedScheme());

  const [fontsLoaded, fontError] = useFonts({
    PlayfairDisplay_400Regular,
    ...Ionicons.font,
  });
  // Don't block rendering on font load — show the app immediately with the fallback
  // font (Georgia on iOS), then swap in PlayfairDisplay once it's ready. Blocking
  // caused a white screen between splash auto-hide and font load completion.
  const headingFont = fontsLoaded ? 'PlayfairDisplay_400Regular' : HEADING_FALLBACK;

  // Load persisted preference on mount.
  useEffect(() => {
    AsyncStorage.getItem(THEME_PREFERENCE_KEY).then((raw) => {
      if (raw === 'light' || raw === 'dark' || raw === 'system') {
        setPreferenceState(raw);
      }
    }).catch(() => {});
  }, []);

  // Re-evaluate the time-based scheme every minute so the theme transitions automatically.
  useEffect(() => {
    const interval = setInterval(() => {
      setAutoScheme(timeBasedScheme());
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  const t = useMemo(
    () => resolveTheme(preference, autoScheme),
    [preference, autoScheme]
  );

  const setPreference = useCallback(async (pref: ThemePreference) => {
    setPreferenceState(pref);
    await AsyncStorage.setItem(THEME_PREFERENCE_KEY, pref);
  }, []);

  const value = useMemo(
    () => ({ t, preference, setPreference, headingFont }),
    [t, preference, setPreference, headingFont]
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
