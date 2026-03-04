import type { StackNavigationOptions } from '@react-navigation/stack';
import type { ThemeTokens } from '../theme/tokens';

/**
 * Global header source of truth for stack navigators.
 * Use this for any native stack headers to avoid per-screen drift.
 */
export function getDefaultHeaderOptions(t: ThemeTokens): StackNavigationOptions {
  const headerBg = t.colors.headerBg ?? t.colors.headerBackground ?? t.colors.surface ?? t.colors.bg;
  const headerText = t.colors.headerText ?? t.colors.textPrimary ?? t.colors.text;
  const headerIcon = t.colors.headerIcon ?? headerText;

  return {
    headerShown: false,
    headerTitleAlign: 'center',
    headerBackButtonDisplayMode: 'minimal',
    headerStyle: {
      backgroundColor: headerBg,
      borderBottomColor: t.colors.divider ?? t.colors.separator ?? t.colors.border,
      borderBottomWidth: 0.5,
      shadowOpacity: 0,
      elevation: 0,
    },
    headerTintColor: headerIcon,
    headerTitleStyle: {
      fontSize: 22,
      fontWeight: '700',
      letterSpacing: 0.5,
      color: headerText,
      alignSelf: 'center',
    },
  };
}

