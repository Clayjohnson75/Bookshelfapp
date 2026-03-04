# Repo secret scan report (high-signal patterns)

**Scan date:** Generated from ripgrep across the repo. **Matches below are redacted:** only pattern type and location are shown; no secret values are printed.

---

## 1. Secret-pattern matches (file : line → pattern type, client vs server)

### SUPABASE_SERVICE_ROLE_KEY / SERVICE_ROLE

| File | Line(s) | Pattern | Match (redacted) | Client/Server |
|------|---------|---------|------------------|----------------|
| api/admin/user-stats.ts | 35 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/undo-delete.ts | 40 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| scripts/reset-dev-passwords.ts | 6, 17, 19, 20, 22, 27 | env read + fallback | SUPABASE_SERVICE_ROLE_KEY \|\| EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY | Server (dangerous fallback) |
| api/scan-status.ts | 43 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/batch-status.ts | 38 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/qstash-test.ts | 16–17, 21, 25 | env read | QSTASH_URL, QSTASH_TOKEN | Server |
| api/scan.ts | 1042, 1081, … 4921, 4831, 4729, 5561, 5585, 5683 | env read + log prefix | GEMINI_API_KEY, OPENAI_API_KEY, SUPABASE_SERVICE_ROLE_KEY, QSTASH_*; serviceKeyPrefix slice(0,6) | Server |
| api/google-books.ts | 54 | env read | SUPABASE_SERVICE_ROLE_KEY \|\| EXPO_PUBLIC_SUPABASE_ANON_KEY | Server (anon fallback) |
| api/update-password.ts | 51 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/update-username.ts | 39, 49 | env read + log | servicePrefix: SUPABASE_SERVICE_ROLE_KEY?.slice(0,6) | Server (log guardrail) |
| api/web-signin.ts | 58 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/check-email-exists.ts | 31 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| lib/rateLimit.ts | 9–10 | env read | UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN | Server |
| api/books/enrich-batch.ts | 39 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/cover-status.ts | 39 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/scan-worker.ts | 17–18, 193, 272–273, 299, 335, 715 | env read + log | QSTASH_*_SIGNING_KEY, SUPABASE_SERVICE_ROLE_KEY; serviceKeyPrefix | Server |
| services/googleBooksService.ts | 15, 29, 36 | env read | SUPABASE_SERVICE_ROLE_KEY (server branch) | Server (code path also in client bundle) |
| api/save-cover.ts | 42 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/debug/book-counts.ts | 34 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/clear-library.ts | 25 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/repair-dangling-photos.ts | 38 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/photo-scan-failed.ts | 23 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/client-telemetry.ts | 82, 105 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/audit-event.ts | 50 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/books/enrich-description.ts | 47 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/register-cover-book.ts | 33 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/delete-library-photo.ts | 42 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/photo-invariant.ts | 34 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/scan-delete.ts | 42 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/sync-scans.ts | 35 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/password-reset.ts | 37, 55 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/test.ts | 7 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/send-confirmation-email.ts | 36, 128, 216–217 | env read | SUPABASE_SERVICE_ROLE_KEY, EMAIL_API_KEY | Server |
| api/send-password-reset.ts | 37, 142, 280–281 | env read | SUPABASE_SERVICE_ROLE_KEY, EMAIL_API_KEY | Server |
| api/set-favorites.ts | 23 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/profile/[username].ts | 57, 62–64 | env read + log | SUPABASE_SERVICE_ROLE_KEY; hasKey, keyLength in console.error | Server |
| api/profile/[username]/edit.ts | 42, 128 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| lib/coverResolution.ts | 56 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/scan/[jobId].ts | 51 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/public-profile/[username].ts | 35 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/scan-cancel.ts | 43 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/books-approve-by-ids.ts | 41 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/cover-resolve-worker.ts | 15–16 | env read | QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY | Server |
| api/import-guest-pending.ts | 26 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/library/ask.ts | 116, 194, 293, 654, 948 | env read | OPENAI_API_KEY, SUPABASE_SERVICE_ROLE_KEY | Server |
| api/get-username.ts | 18 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/scan-job.ts | 32, 147, 160, 232, 280 | env read | SUPABASE_SERVICE_ROLE_KEY, QSTASH_TOKEN | Server |
| api/auto-sort-books.ts | 43 | env read | process.env.OPENAI_API_KEY | Server |
| api/validate-apple-receipt.ts | 43, 134 | env read / comment | SUPABASE_SERVICE_ROLE_KEY, APPLE_SHARED_SECRET | Server |
| api/generate-avatar.ts | 21 | env read | process.env.OPENAI_API_KEY | Server |
| api/library-books.ts | 21 | env read | process.env.SUPABASE_SERVICE_ROLE_KEY | Server |
| api/get-email-by-username.ts | 32–33 | env read | SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SERVICE_ROLE_KEY_DEV | Server |
| api/admin/check.ts | 7, 58, 62 | comment + env read | SUPABASE_SERVICE_ROLE_KEY | Server |
| lib/workers/metaEnrich.ts | 8, 77 | comment | SUPABASE_SERVICE_ROLE_KEY | Server |
| lib/enqueueCoverResolve.ts | 22–23 | env read | QSTASH_TOKEN, QSTASH_URL | Server |
| lib/coverRateLimit.ts | 3, 7–8 | comment + env read | UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN | Server |

### Literal key patterns (sk-, ghp_, AIza, AKIA, postgres://, PEM, etc.)

| Pattern | Matches |
|---------|--------|
| sk-[A-Za-z0-9]{20,} | **None** |
| ghp_[A-Za-z0-9]{20,} | **None** |
| AIza[0-9A-Za-z\-_]{35} | **None** |
| AKIA[0-9A-Z]{16} | **None** |
| postgres(ql)?:// | **None** |
| -----BEGIN (RSA\|OPENSSH\|EC) PRIVATE KEY----- | **None** |

### JWT / JWKS / signing key (references only; no raw secrets)

| File | Line(s) | Pattern | Client/Server |
|------|---------|---------|----------------|
| api/register-cover-book.ts | 6 | comment JWKS | Server |
| lib/securityBaseline.ts | 23 | comment: never log JWTs | Shared |
| api/update-username.ts | 10 | comment JWKS | Server |
| api/check-subscription.ts | 10–28 | JWT from header, Bearer | Server |
| auth/SimpleAuthContext.tsx | 7 | comment JWT alg | Client |
| api/client-telemetry.ts | 22 | redact list includes 'jwt' | Server |
| app.config.js | 90 | comment JWT | Build |
| api/cover-status.ts | 6 | comment JWKS | Server |
| lib/jwtAlg.ts | 2, 5 | jwtAlg(token) | Shared |
| api/scan-worker.ts | 207, 277, 298–299 | QStash signing, JWT-looking | Server |
| api/verifySupabaseJwt.ts | 2–37 | JWKS URL, jwtVerify | Server |
| api/library/ask.ts | 50–51, 847–908 | JWT from header, decode | Server |

No **literal** JWT secrets or signing keys found in repo; only code that uses JWTs/JWKS.

---

## 2. EXPO_PUBLIC_ variables and where used (client vs server)

| Variable | Where used | Client or Server |
|----------|------------|-------------------|
| **EXPO_PUBLIC_SUPABASE_URL** | api/* (supabaseUrl fallback), lib/supabaseBrowser.ts, lib/supabaseServerCookies.ts, lib/coverResolution.ts, lib/supabase/client.ts, services/googleBooksService.ts, app.config.js → extra | Server (api, lib for server paths); Client (lib/supabase.ts via extra, lib/supabase/client.ts) |
| **EXPO_PUBLIC_SUPABASE_ANON_KEY** | api/* (anonKey for auth), lib/supabaseBrowser.ts, lib/supabaseServerCookies.ts, lib/supabase/client.ts, app.config.js → extra | Server (auth routes); Client (lib/supabase.ts via extra, lib/supabase/client.ts) |
| **EXPO_PUBLIC_API_BASE_URL** | lib/getEnvVar.ts, lib/supabase.ts, lib/authHeaders.ts, App.tsx, components/SettingsModal.tsx, screens/LibraryView.tsx, auth/SimpleAuthContext.tsx, tabs/ExploreTab.tsx, tabs/MyLibraryTab.tsx, services/googleBooksService.ts (extra), app.config.js → extra | **Client** (primary); Server (authHeaders, api only for reference) |
| **EXPO_PUBLIC_SUPABASE_URL_DEV** | api/get-email-by-username.ts, lib/supabase.ts (error message), auth/SimpleAuthContext.tsx (Alert), app.config.js | Server (get-email); Client (supabase.ts error, auth Alert); Build (app.config) |
| **EXPO_PUBLIC_SUPABASE_ANON_KEY_DEV** | lib/supabase.ts (error), auth/SimpleAuthContext.tsx (Alert), app.config.js | Client (error/Alert); Build (app.config) |
| **EXPO_PUBLIC_API_BASE_URL_DEV** | app.config.js | Build only |
| **EXPO_PUBLIC_LOG_LEVEL** | utils/logger.ts | Client |
| **EXPO_PUBLIC_LOG_CATEGORIES** | utils/logger.ts | Client |
| **EXPO_PUBLIC_DEBUG_TRACE_ID** | utils/logger.ts | Client |
| **EXPO_PUBLIC_DEBUG_INTEGRITY** | utils/logger.ts | Client |
| **EXPO_PUBLIC_DEBUG_STACKS** | utils/logger.ts | Client |
| **EXPO_PUBLIC_LOG_DEBUG** | lib/getEnvVar.ts, auth/SimpleAuthContext.tsx | Client |
| **EXPO_PUBLIC_LOG_NET** | lib/supabase.ts, lib/logFlags.ts | Client |
| **EXPO_PUBLIC_LOG_SNAPSHOT** | lib/logFlags.ts | Client |
| **EXPO_PUBLIC_LOG_SCAN** | lib/logFlags.ts | Client |
| **EXPO_PUBLIC_LOG_APPROVE** | lib/logFlags.ts | Client |
| **EXPO_PUBLIC_LOG_TRACE** | lib/logFlags.ts | Client |
| **EXPO_PUBLIC_LOG_POLL** | lib/logFlags.ts | Client |
| **EXPO_PUBLIC_LOG_UI** | lib/logFlags.ts | Client |
| **EXPO_PUBLIC_DEBUG_PENDING** | lib/logFlags.ts | Client |
| **EXPO_PUBLIC_DEBUG_VERBOSE** | lib/logFlags.ts | Client |
| **EXPO_PUBLIC_USE_PURE_JS_HASH** | lib/logFlags.ts | Client |
| **EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY** | scripts/reset-dev-passwords.ts (fallback) | **Server only** — **remove this fallback** (dangerous) |

**Summary:** All EXPO_PUBLIC_ usages are either (1) client-safe config (Supabase URL, anon key, API base URL, log flags) or (2) server/build-only. The only **dangerous** one is **EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY** in `scripts/reset-dev-passwords.ts`; it should be removed so the script uses only `SUPABASE_SERVICE_ROLE_KEY`.

---

## 3. Recommendations

1. **Remove dangerous fallbacks:** `EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` in reset-dev-passwords.ts; anon-key fallback for cache in api/google-books.ts (prefer service role only).
2. **Log guardrails:** Remove `keyLength`, `serviceKeyPrefix` / `servicePrefix` (any slice of service role key) from server log objects (api/profile/[username].ts, api/update-username.ts, api/scan.ts, api/scan-worker.ts).
3. **Bundle:** Keep service-role code path out of client bundle (googleBooksService server branch); see [BUNDLE_SECRET_CHECK.md](BUNDLE_SECRET_CHECK.md).
4. **No literal secrets** were found (no sk-, ghp_, AIza, AKIA, postgres://, PEM); all matches are env var **names** or **references** in server-side code.
