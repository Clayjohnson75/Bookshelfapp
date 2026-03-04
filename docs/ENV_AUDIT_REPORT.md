# Environment variable audit: client vs server

This document lists which env vars are used in **client** (Expo/React Native bundle, browser) vs **server** (Vercel API routes, Edge Functions, scripts), and what must never be exposed to the client.

## Summary

- **Client bundle** only receives values that are set in `app.config.js` → `expo.extra`. That is intentionally limited to: `supabaseUrl`, `supabaseAnonKey`, `EXPO_PUBLIC_API_BASE_URL`, and `eas.projectId`. No secret keys are in the client.
- **Server** reads from `process.env` (Vercel env vars, or `.env` at build time for scripts). Secrets (service role, API keys, etc.) are server-only.
- **Recommendation:** Do not add any secret to `expo.extra` or to any `EXPO_PUBLIC_*` var that is passed into `getEnvVar()` from client code.

---

## Env vars used in **client** code (and where)

Client code = code that runs in the Expo app (screens, components, tabs, auth, App.tsx) or in the browser for web builds. It gets config from `getEnvVar()` which reads `Constants.expoConfig.extra` (and fallback `process.env` at build time; only EXPO_PUBLIC_* are inlined by Metro for client).

| Env key (source) | Where used | Notes |
|------------------|------------|--------|
| `supabaseUrl` (from extra) | `lib/supabase.ts` | Single app Supabase client; set in app.config.js from EXPO_PUBLIC_SUPABASE_URL / SUPABASE_URL |
| `supabaseAnonKey` (from extra) | `lib/supabase.ts` | Same; set from EXPO_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_ANON_KEY |
| `EXPO_PUBLIC_API_BASE_URL` | `lib/supabase.ts`, `lib/getEnvVar.ts` (getApiBaseUrl), `App.tsx`, `components/SettingsModal.tsx` | API base URL for scan and other server calls |
| `EXPO_PUBLIC_LOG_LEVEL` | `utils/logger.ts` | Log level (error/warn/info/debug/trace) |
| `EXPO_PUBLIC_LOG_CATEGORIES` | `utils/logger.ts` | Comma list of categories to show at INFO |
| `EXPO_PUBLIC_DEBUG_TRACE_ID` | `utils/logger.ts` | Filter logs by traceId |
| `EXPO_PUBLIC_DEBUG_INTEGRITY` | `utils/logger.ts` | Emit full detail for integrity check logs |
| `EXPO_PUBLIC_DEBUG_STACKS` | `utils/logger.ts` | Include stack in warn/error |
| `EXPO_PUBLIC_LOG_DEBUG` | `lib/getEnvVar.ts` (logEnvConfigOnce) | One-time env config log |
| `NODE_ENV` | `lib/getEnvVar.ts` (indirect), `services/googleBooksService.ts` (isDev) | Build-time only in client |

**Important:** `getEnvVar('GOOGLE_BOOKS_API_KEY')` is called in `services/googleBooksService.ts`, which can run in the app. The value there comes from `expo.extra` or `process.env`. `app.config.js` does **not** put `GOOGLE_BOOKS_API_KEY` into `extra`, so in the client bundle that value is always empty. Google Books from the app goes through your API (server), not with a client-held key. Safe.

---

## Env vars used only in **server** code (api/, lib/ used by api, scripts)

These must **never** be added to `expo.extra` or exposed to the client.

| Env key | Where used (representative) | Purpose |
|---------|-----------------------------|---------|
| `SUPABASE_SERVICE_ROLE_KEY` | All api/* that create admin client; `lib/coverResolution.ts` (getSupabase); `lib/workers/metaEnrich.ts`; `scripts/reset-dev-passwords.ts` | Server-only Supabase admin |
| `SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_URL` | api/*, lib/supabaseBrowser.ts, lib/supabaseServerCookies.ts | URL for Supabase (server may use either) |
| `SUPABASE_ANON_KEY` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` | api/* (auth flows: signin, confirm-email, check-subscription, refresh-token, update-password, web-signin, confirm-email-api), lib/supabaseBrowser.ts, lib/supabaseServerCookies.ts | Anon client for auth (server-side only in these routes) |
| `OPENAI_API_KEY` | api/auto-sort-books.ts | OpenAI |
| `GOOGLE_BOOKS_API_KEY` | api/google-books.ts, lib/enrichDescription.ts, services/googleBooksService.ts (server path) | Google Books API |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `QSTASH_URL` | api/scan-job.ts, api/cover-resolve-worker.ts, lib/enqueueCoverResolve.ts | QStash |
| `EMAIL_API_KEY`, `EMAIL_FROM` | api/send-password-reset.ts, api/send-confirmation-email.ts | Resend / email |
| `COVER_RESOLVE_WORKER_URL` | lib/enqueueCoverResolve.ts | Worker URL |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | lib/coverRateLimit.ts | Redis rate limit |
| `APPLE_SHARED_SECRET` | api/validate-apple-receipt.ts | Apple IAP |
| `ENABLE_PRO_FOR_EVERYONE` | api/check-subscription.ts | Feature flag |
| `NODE_ENV` | api/scan-reaper.ts, api/get-email-by-username.ts, api/profile/[username].ts | Guard / debug |
| `DEBUG_TILES` | lib/imageTiles.ts (server/build-time only in practice) | Debug |
| `SUPABASE_SERVICE_ROLE_KEY_DEV`, `SUPABASE_URL_DEV` | api/get-email-by-username.ts, scripts | Dev overrides |

---

## Rename / move recommendations

1. **scripts/reset-dev-passwords.ts**  
   It currently falls back to `EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`. **Remove that fallback.** Use only `SUPABASE_SERVICE_ROLE_KEY` so the service role key is never encouraged to be set in a client-exposed variable.

2. **app.config.js**  
   Keep only these in `expo.extra`: `supabaseUrl`, `supabaseAnonKey`, `EXPO_PUBLIC_API_BASE_URL`, `eas`. Do not add any of: `GOOGLE_BOOKS_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, or other secrets.

3. **api/google-books.ts**  
   If it still has an anon-key fallback for cache, prefer requiring service role for that path so cache is always server-scoped.

---

## Verification

- **No secret keys** are referenced by client-only code paths. Client uses only Supabase anon key, API base URL, and debug/log flags.
- **Compiled client bundle:** Expo/Metro inlines only what is in `expo.extra` and `EXPO_PUBLIC_*` used at build time. `app.config.js` does not put secrets into `extra`.
- **getEnvVar():** In client, it reads from `Constants.expoConfig.extra` first; server-only keys are not in `extra`, so they are not in the client bundle.
