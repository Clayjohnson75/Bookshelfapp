/**
 * Theme provider + hook. Single source of truth for appearance.
 * Theme is auth-independent: preference stored in AsyncStorage and applies
 * before sign-in (guest scan / sign-in flows unchanged).
 * Stores themePreference: 'system' | 'light' | 'dark'. Resolves: dark → scriptoriumDark.
 *
 * Auto ('system') mode: follows the OS appearance setting via useColorScheme().
 * Changes automatically when the user toggles system dark mode or it switches
 * at sunset/sunrise (if the OS has scheduled dark mode).
 *
 * useTheme() → { t, setPreference, preference, headingFont }
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getTheme, type ThemeTokens } from './tokens';

export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_PREFERENCE_KEY = 'theme_preference';

/** System serif fallback for headings when custom font not yet loaded (iOS: Georgia). */
const HEADING_FALLBACK = Platform.select({ ios: 'Georgia', default: 'serif' });

function resolveTheme(preference: ThemePreference, osScheme: 'light' | 'dark'): ThemeTokens {
  if (preference === 'light') return getTheme('light');
  if (preference === 'dark') return getTheme('scriptoriumDark');
  // Auto: follow OS appearance setting (respects system dark mode schedule).
  return osScheme === 'dark' ? getTheme('scriptoriumDark') : getTheme('light');
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

  // Track OS appearance — updates automatically when system dark mode toggles.
  const osColorScheme = useColorScheme(); // 'light' | 'dark' | null
  const osScheme: 'light' | 'dark' = osColorScheme === 'dark' ? 'dark' : 'light';

  // Use system serif (Georgia on iOS) for headings. Custom font loading removed
  // as useFonts caused production crashes with the new architecture.
  const headingFont = HEADING_FALLBACK;

  // Load persisted preference on mount.
  useEffect(() => {
    AsyncStorage.getItem(THEME_PREFERENCE_KEY).then((raw) => {
      if (raw === 'light' || raw === 'dark' || raw === 'system') {
        setPreferenceState(raw);
      }
    }).catch(() => {});
  }, []);

  const t = useMemo(
    () => resolveTheme(preference, osScheme),
    [preference, osScheme]
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
