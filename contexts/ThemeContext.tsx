/**
 * Theme context: single source of truth for appearance.
 * Preference: System | Light | Dark (Modern Scriptorium). Resolves to ThemeTokens for the whole app.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getTheme, type ThemeName, type ThemeTokens } from '../theme/tokens';

export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_PREFERENCE_KEY = 'theme_preference';

function resolveTheme(preference: ThemePreference, systemScheme: 'light' | 'dark' | null): ThemeTokens {
  if (preference === 'light') return getTheme('light');
  if (preference === 'dark') return getTheme('scriptoriumDark');
  const scheme = systemScheme ?? Appearance.getColorScheme();
  return scheme === 'dark' ? getTheme('scriptoriumDark') : getTheme('light');
}

interface ThemeContextType {
  themePreference: ThemePreference;
  theme: ThemeTokens;
  setThemePreference: (pref: ThemePreference) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>('system');
  const [systemColorScheme, setSystemColorScheme] = useState<'light' | 'dark' | null>(
    () => Appearance.getColorScheme()
  );

  useEffect(() => {
    AsyncStorage.getItem(THEME_PREFERENCE_KEY).then((raw) => {
      if (raw === 'light' || raw === 'dark' || raw === 'system') {
        setThemePreferenceState(raw);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemColorScheme(colorScheme ?? 'light');
    });
    return () => sub.remove();
  }, []);

  const theme = useMemo(
    () => resolveTheme(themePreference, systemColorScheme),
    [themePreference, systemColorScheme]
  );

  const setThemePreference = useCallback(async (pref: ThemePreference) => {
    setThemePreferenceState(pref);
    await AsyncStorage.setItem(THEME_PREFERENCE_KEY, pref);
  }, []);

  const value = useMemo(
    () => ({ themePreference, theme, setThemePreference }),
    [themePreference, theme, setThemePreference]
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextType {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
