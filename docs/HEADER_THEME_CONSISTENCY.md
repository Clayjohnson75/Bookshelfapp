# Header Theme Consistency

## Source of Truth

- Theme tokens: `theme/tokens.ts` (`headerLight`, `headerDark`, `headerBackground`, text tokens, divider tokens)
- Shared header style helpers: `lib/headerTheme.ts`
- Shared header component: `components/AppHeader.tsx`
- Shared navigator options: `lib/headerOptions.ts` (`getDefaultHeaderOptions`)

## Navigator Rules

- Every stack navigator in `TabNavigator.tsx` uses `screenOptions={getDefaultHeaderOptions(t)}`.
- Screen-level custom headers must use `AppHeader`, not ad-hoc wrappers.

## Intentional Exceptions

These screens use custom top layouts for tab hero UX but still resolve all colors from the shared header helpers and tokens:

- `tabs/ScansTab.tsx` — canonical custom tab hero header
- `tabs/MyLibraryTab.tsx` — editorial profile hero header

All other standard screen and modal headers should use `AppHeader` (or stack-level `getDefaultHeaderOptions`).

## Dev QA Route

In dev builds, use the `Theme QA` tab to open the `ThemeQA` route (`screens/ThemeConsistencyTestScreen.tsx`). Use it to verify header background token, title style, icon sizing, divider/shadow behavior, and safe-area spacing across key screens. Entry: long-press the top DEV badge.
