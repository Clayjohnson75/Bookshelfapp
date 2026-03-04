/**
 * Theme provider + hook. Single source of truth for appearance.
 * Theme is auth-independent: preference stored in AsyncStorage and applies
 * before sign-in (guest scan / sign-in flows unchanged).
 * Stores themePreference: 'system' | 'light' | 'dark'. Resolves: dark scriptoriumDark.
 * useTheme() { t, setPreference, preference, headingFont }
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFonts } from '@expo-google-fonts/playfair-display/useFonts';
import { PlayfairDisplay_400Regular } from '@expo-google-fonts/playfair-display';
import Ionicons from '@expo/vector-icons/Ionicons';
import { getTheme, type ThemeName, type ThemeTokens } from './tokens';

export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_PREFERENCE_KEY = 'theme_preference';

/** System serif fallback for headings when custom font not yet loaded (iOS: Georgia). */
const HEADING_FALLBACK = Platform.select({ ios: 'Georgia', default: 'serif' });

function resolveTheme(preference: ThemePreference, systemScheme: 'light' | 'dark' | null): ThemeTokens {
 if (preference === 'light') return getTheme('light');
 if (preference === 'dark') return getTheme('scriptoriumDark');
 const scheme = systemScheme ?? Appearance.getColorScheme();
 return scheme === 'dark' ? getTheme('scriptoriumDark') : getTheme('light');
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
 const [systemColorScheme, setSystemColorScheme] = useState<'light' | 'dark' | null>(
 () => Appearance.getColorScheme()
 );

 const [fontsLoaded, fontError] = useFonts({
   PlayfairDisplay_400Regular,
   ...Ionicons.font,
 });
 const [showContent, setShowContent] = useState(false);
 useEffect(() => {
   if (fontsLoaded || fontError) setShowContent(true);
   const t = setTimeout(() => setShowContent(true), 3000);
   return () => clearTimeout(t);
 }, [fontsLoaded, fontError]);
 const headingFont = fontsLoaded ? 'PlayfairDisplay_400Regular' : HEADING_FALLBACK;

 useEffect(() => {
 AsyncStorage.getItem(THEME_PREFERENCE_KEY).then((raw) => {
 if (raw === 'light' || raw === 'dark' || raw === 'system') {
 setPreferenceState(raw);
 }
 }).catch(() => {});
 }, []);

 useEffect(() => {
 const sub = Appearance.addChangeListener(({ colorScheme }) => {
 setSystemColorScheme(colorScheme ?? 'light');
 });
 return () => sub.remove();
 }, []);

 const t = useMemo(
 () => resolveTheme(preference, systemColorScheme),
 [preference, systemColorScheme]
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
 {showContent ? children : null}
 </ThemeContext.Provider>
 );
}

export function useTheme(): ThemeContextValue {
 const ctx = useContext(ThemeContext);
 if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
 return ctx;
}
