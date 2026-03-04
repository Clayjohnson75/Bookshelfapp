# Bookshelf Scanner: Complete App & Security Reference

Single reference for how the app and website work, how every part runs, and how security is enforced end-to-end.

---

## Table of contents

1. [Overview & stack](#1-overview--stack)
2. [App architecture](#2-app-architecture)
3. [Authentication](#3-authentication)
4. [Data model & storage](#4-data-model--storage)
5. [Scan flow (photo → books)](#5-scan-flow-photo--books)
6. [Library, approve & sync](#6-library-approve--sync)
7. [API routes reference](#7-api-routes-reference)
8. [Security (keys, RLS, bundle, secrets)](#8-security-keys-rls-bundle-secrets)
9. [Config & environment](#9-config--environment)
10. [Deployment & cron](#10-deployment--cron)
11. [Key files quick reference](#11-key-files-quick-reference)

---

## 1. Overview & stack

- **App:** Expo (React Native) for iOS, Android, and web. Single codebase; native tabs and screens.
- **Backend:** Supabase (PostgreSQL, Auth, Storage, RLS). Server logic runs on **Vercel** as serverless API routes (Node).
- **Client data:** Supabase anon key for direct REST/Realtime (RLS-protected); plus AsyncStorage for durable local cache (`books_${userId}`, `photos_${userId}`, `approved_books_${userId}`, upload/approve queues).
- **Secrets:** Anon key and API base URL in client (expo.extra). Service role, OpenAI, Google Books, QStash, Apple, etc. only in server env (Vercel / scripts). Never in repo or client bundle.

---

## 2. App architecture

### Entry and shell

- **`index.js`** → **`AppWrapper.tsx`** (auth gate, upload/approve workers, theme) → **`TabNavigator.tsx`** (bottom tabs + stack screens).
- **Auth:** Wrapped in `AuthProvider` from `auth/SimpleAuthContext.tsx`. Session comes from Supabase only (email/password); no Apple/Google OAuth tokens as session.
- **Single Supabase client:** `lib/supabase.ts` creates one `createClient(url, anonKey)` with AsyncStorage for session persistence. All app code imports `{ supabase }` from here. API routes and scripts create their own clients (service role or anon) on the server.

### Tabs and main screens

| Tab / Screen | Role |
|--------------|------|
| **ScansTab** | Pick/capture photos, upload queue, scan jobs, approve/reject books, pending scans. Uses `ScanningContext`, `BottomDockContext`, `PhotoUploadQueue`, `approveQueue`. |
| **MyLibraryTab** | Approved books, folders, authors, cover grid. Reads from AsyncStorage + server merge; `ProfileStatsContext` for counts. |
| **ExploreTab** | Search, public profiles (optional). |
| **PhotosScreen** | Grid of user photos (from Scans). |
| **PhotoDetailScreen** | One photo and its books. |
| **BookDetailScreen** | Single book: metadata, description, cover, edit. Triggers `POST /api/books/enrich-description` when description missing. |
| **AddCaptionScreen** | Add caption to photo. |
| **SelectCollectionScreen** | Choose folder/collection for books. |

### Contexts (global state / workers)

- **SimpleAuthContext:** User, session, signIn/signOut, refresh, username (canonical from `profiles`), biometric.
- **ScanningContext:** Active scan job IDs, progress, cancel ref, failed upload count.
- **BottomDockContext:** Tab bar height, selection bar content (Scans).
- **ThemeContext:** Theme tokens (no hex in code; see `theme/tokens.ts`).
- **ProfileStatsContext:** Approved count, photo count (invalidated after approve/sync).
- **CoverUpdateContext, SignedPhotoUrlContext, PhotoSignedUrlPersistContext:** Cover URLs and signed photo URLs.
- **CameraContext:** Camera active state.

Workers started in **AppWrapper:** photo upload worker (`lib/photoUploadQueue.ts`), approve worker (`lib/approveQueue.ts`). They run on an interval and persist queues to AsyncStorage; not tied to a specific tab so upload/approve continue if the user leaves the tab or kills the app.

---

## 3. Authentication

- **Method:** Email/password only. Supabase Auth; no Apple/Google OAuth or ID tokens as session.
- **Session:** Stored via Supabase client (AsyncStorage). Token refresh is automatic. Server APIs that need auth use the `Authorization: Bearer <access_token>` from the client or cookie (web).
- **Username:** Single source of truth is **profiles** table. Read from profiles when available; write only via **`api/update-username`**. Never merge usernames from multiple sources; avoid stale overwrites (see `resolveUsername` in SimpleAuthContext).
- **Guest:** `GUEST_USER_ID` / `isGuest` for local-only use; no Supabase account. Converting guest → real user uses import/merge flows (e.g. `api/import-guest-pending`).
- **Web sign-in:** `api/web-signin.ts`, `api/web-sync-session.ts` for cookie-based web auth; anon client for sign-in, service role only for admin steps where needed.
- **Password reset / confirm email:** `api/send-password-reset`, `api/confirm-email`, `api/confirm-email-api`, `api/update-password`, `api/refresh-token`, `api/session-refresh`.

---

## 4. Data model & storage

### Supabase (PostgreSQL)

- **profiles:** id (auth.users.id), username, display_name, avatar_url, updated_at. RLS: own row only.
- **books:** id, user_id, book_key, title, author, status (pending/approved/rejected), source_photo_id, source_scan_job_id, description, enrichment fields, cover_url, etc. RLS: user_id = auth.uid().
- **photos:** id, user_id, storage_path, image_hash, status, processing_stage, deleted_at, etc. RLS: user_id = auth.uid(). One canonical photo per (user_id, image_hash) (unique index).
- **scan_jobs:** id (UUID), user_id, photo_id, scan_id, status, stage, progress, books (JSONB), batch_id, image_hash, etc. RLS: user_id = auth.uid(). Must have photo_id set after dedupe (invariant).
- **user_stats:** Aggregates per user. RLS: own row only; no `WITH CHECK (true)`.
- **client_telemetry:** Events from client (high-signal). RLS: anon INSERT with user_id IS NULL; authenticated INSERT with user_id IS NULL OR user_id = auth.uid(); no SELECT for anon/authenticated.
- **book_metadata_cache, cover_resolutions, cover_aliases, google_books_cache:** Server-side or RLS-scoped as per migrations.
- **Private schema:** e.g. `private.user_activity_stats`, `private.user_stats_with_usernames` — server-only (service role), not exposed to anon.

### Local (AsyncStorage)

- **`books_${userId}`** — approved/pending book list (merged with server on load).
- **`photos_${userId}`** — photo list (merged with server; durable so tiles survive tab switch / app kill).
- **`approved_books_${userId}`** — list of approved book row IDs (UUIDs only; no composite IDs).
- **`upload_queue_${userId}`** — photo upload queue (durable).
- **Approve outbox / queue** — persisted by `lib/approveQueue.ts` / `lib/approveMutationsOutbox.ts`; worker runs from AppWrapper.
- **`PENDING_APPROVE_ACTION_KEY`, `ACTIVE_USER_ID_KEY`** — cache keys (see `lib/cacheKeys.ts`).

Merge rules (no “0 books” regression): when server returns 0 approved books or 0 photos, we do not overwrite local non-empty state unless the user explicitly cleared library or the merge logic explicitly allows empty. See `lib/dedupBy.ts`, `lib/mergeBooks.ts`, and ScansTab empty guards.

---

## 5. Scan flow (photo → books)

1. **Pick/capture photo** (ScansTab). New photo appended to local `photos` and persisted to `photos_${userId}`; tile shows “Uploading…” immediately.
2. **Upload queue** (`lib/photoUploadQueue.ts`). Worker (from AppWrapper) uploads image to Supabase Storage; on success gets `storage_path`, creates/gets photo row (dedupe by `image_hash`: reuse existing photo or insert new). Patches `scan_jobs.photo_id` when dedupe reuses a photo.
3. **Create scan job.** Client calls **`POST /api/scan`** with `imageDataURL` (or metadata-only with `photoId` + `storagePath`). API:
   - Validates auth (JWT), decodes image (size cap), computes `image_hash`.
   - Resolves photo: existing by (user_id, image_hash) or creates new; gets canonical `photo_id`.
   - Inserts/upserts **scan_jobs** row (id, user_id, photo_id, status: pending, etc.).
   - Can publish to **QStash** for async processing (cron also hits scan-job).
4. **Process job.** **`api/scan-job`** (or **`api/scan-worker`**) invoked by cron or QStash; calls **`processScanJob`** from **`api/scan.ts`**:
   - Fetches image (from storage or body), runs **Gemini** (or configured AI) for book detection.
   - Normalizes books, assigns work_key, writes progress to scan_jobs.
   - On completion: updates scan_jobs (status completed, books JSONB). Then **upsert books** into **books** table with `source_photo_id` = job’s `photo_id`, `source_scan_job_id` = job id.
   - Enqueues cover resolution (e.g. **api/cover-resolve-worker**); meta-enrich worker can run for description/metadata.
5. **Client:** Polls **`GET /api/scan-status`** or syncs via **`api/sync-scans`**; merges jobs and books into local state. User sees pending books; can approve/reject.
6. **Invariants:** Every book row has `source_photo_id`. No book references a missing photo. After photo dedupe, `scan_jobs.photo_id` is patched and books use that canonical photo_id. See `.cursor/rules/photo-book-relationship-invariants.mdc` and `api/photo-invariant.ts` for checks.

---

## 6. Library, approve & sync

- **Approve:** User taps Approve (all or selection). Optimistic update to local state + AsyncStorage; **approve queue** (`lib/approveQueue.ts`) enqueues payload. Worker calls **`api/books-approve-by-ids`** (or equivalent), persists `approved_books_${userId}` and `photos_${userId}`, then **`api/scan-mark-imported`**. No blocking await on approve; durable so leaving the tab or killing the app still completes in background.
- **Merge / field-level:** When merging server and local books for the same book_key, use **field-level merge** (title/author prefer local once approved; id/dbId prefer server; enrichment prefer server). See `lib/mergeBooks.ts` and `.cursor/rules/merge-approve-lock.mdc`. **book_key** is stable; never recompute from AI after approve; persist at approve time.
- **Sync on open/focus:** Load from AsyncStorage and from server (library-books, sync-scans, profile stats); merge by book id and book_key; apply empty guards so we don’t show 0 books when server is slow or partial. Refresh profile stats after approve/sync.
- **Delete photo:** Explicit user action only. **`api/delete-library-photo`** soft-deletes photo and cascades to books with `source_photo_id` = that photo (cascadeBooks = true only on explicit delete). Never auto-delete photos that have approved books.

---

## 7. API routes reference

All under **`api/`**; Vercel serverless. Auth via `Authorization: Bearer <JWT>` or cookie (web). Service role used only where listed below (server-side).

| Route | Purpose | Auth | Service role |
|-------|---------|------|--------------|
| **POST /api/scan** | Create/upsert scan job; optionally start processing | JWT | Yes (Supabase admin) |
| **GET/POST /api/scan-job** | Create job + trigger processing (cron/QStash) | JWT / QStash | Yes |
| **GET /api/scan/[jobId]** | Job status | JWT | Yes |
| **GET /api/scan-status** | Multi-job status for user | JWT | Yes |
| **POST /api/sync-scans** | Sync scans/jobs/books for user | JWT | Yes |
| **POST /api/scan-worker** | Process one job (worker) | Internal/QStash | Yes |
| **api/scan-cancel, scan-delete, delete-pending-scan** | Cancel/delete scan or pending | JWT | Yes |
| **api/scan-mark-imported** | Mark job imported after approve | JWT | Yes |
| **api/scan-job-patch-photo** | Patch scan_jobs.photo_id (dedupe) | JWT | Yes |
| **api/scan-reaper** | Cleanup old jobs (cron) | Cron | Yes |
| **api/books-approve-by-ids** | Approve books by ID | JWT | Yes |
| **api/books/enrich-description** | Single-book description enrich | JWT | Yes |
| **api/books/enrich-batch** | Batch enrich | JWT | Yes |
| **api/library-books** | Library books for user | JWT | Yes |
| **api/library/ask** | Library chat/ask | JWT | Anon (RLS) |
| **api/delete-library-photo** | Delete photo + cascade books | JWT | Yes |
| **api/undo-delete** | Undo soft-delete | JWT | Yes |
| **api/clear-library** | Clear user library | JWT | Yes |
| **api/google-books** | Google Books proxy + cache | - | Yes (cache) |
| **api/cover-status, resolve-cover, save-cover, register-cover-book** | Cover resolution | JWT | Yes |
| **api/cover-resolve-worker** | Cover worker (QStash) | Internal | Yes |
| **api/meta-enrich-worker** | Metadata enrichment | Internal | Yes |
| **api/client-telemetry** | Ingest client events | Optional JWT | Yes (insert) |
| **api/signin, web-signin, refresh-token, update-password** | Auth | - | Anon / service for admin |
| **api/send-password-reset, send-confirmation-email, confirm-email** | Email flows | - | Yes where needed |
| **api/profile, profile/[username], profile/[username]/edit** | Profile read/edit | JWT / public | Yes for cross-user |
| **api/public-profile/[username]** | Public profile | - | Yes |
| **api/check-subscription, validate-apple-receipt** | Subscription / IAP | JWT | Yes |
| **api/search** | Search | - | Depends |
| **api/batch-status** | Batch status | JWT | Yes |
| **api/import-guest-pending** | Import guest data | JWT | Yes |
| **api/repair-dangling-photos** | Repair photo/book links | JWT | Yes |
| **api/photo-invariant** | Diagnostic: photo/job/books chain | JWT | Yes |
| **api/photo-scan-failed** | Mark scan failed | JWT | Yes |
| **api/audit-event** | Audit log | JWT | Yes |
| **api/admin/check, admin/user-stats** | Admin | Admin | Yes |
| **api/debug/*, get-username, get-email-by-username, check-email-exists** | Debug / admin | Varies | Yes where needed |

---

## 8. Security (keys, RLS, bundle, secrets)

### 8.1 Keys: anon vs service role

- **Anon key:** In client only (`lib/supabase.ts`, `lib/supabase/client.ts`). Also used server-side for auth routes (signin, refresh, confirm-email, etc.) and for RLS-scoped reads (e.g. library/ask). Safe only because **RLS** restricts rows to `auth.uid()`.
- **Service role key:** Only in server env (Vercel, scripts). Used by all api/* that need to bypass RLS (scan, books, photos, admin, workers). **Never** in repo, **never** in expo.extra or EXPO_PUBLIC_*, **never** in client bundle. See `docs/SERVICE_ROLE_NEVER_REACHES_CLIENT.md` and `docs/SUPABASE_KEY_HYGIENE.md`.
- **Google Books / Gemini:** Client never holds keys. Client calls **`/api/google-books`** proxy; caching and API key live in **api/google-books.ts** only. `services/googleBooksService.ts` is client-safe (no service role, no GOOGLE_BOOKS_API_KEY).

### 8.2 expo.extra allowlist

- **app.config.js** builds `expo.extra` and **validates** at build time: only these keys are allowed: **supabaseUrl**, **supabaseAnonKey**, **EXPO_PUBLIC_API_BASE_URL**, **eas**. Any other key throws. Blocklist forbids e.g. GOOGLE_BOOKS_API_KEY, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, etc. So “oops we added a secret to extra” cannot ship.

### 8.3 RLS (Row Level Security)

- All user-scoped tables have RLS enabled. Policies use **`(select auth.uid())`** (initplan) for performance.
- **user_stats:** Only own row: `user_id = (select auth.uid())` for ALL (SELECT/INSERT/UPDATE/DELETE). No `WITH CHECK (true)`.
- **client_telemetry:** anon INSERT only with `user_id IS NULL`; authenticated INSERT with `user_id IS NULL OR user_id = (select auth.uid())::text`. No SELECT for anon/authenticated.
- **books, photos, scan_jobs, profiles:** Standard own-row policies. See `supabase-migrations/enable-rls-public-tables.sql`, `database-security-lockdown.sql`, and `docs/RLS_USER_STATS_AND_TELEMETRY.md`.

### 8.4 Bundle and artifact scanning

- **CI** (`.github/workflows/ci.yml`): Runs **gitleaks** (repo + history) with **.gitleaks.toml** (allowlist for anon JWT in app.config.js and ci.yml only). Builds web with **`npx expo export --platform web`** with **GENERATE_SOURCEMAP=false**, then **scripts/ci-bundle-scan.sh** scans **dist/_expo/static/js/web/*.js** (and *.js.map if present) for forbidden patterns. Fails if any of: SUPABASE_SERVICE_ROLE_KEY, EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, QSTASH_, GOOGLE_BOOKS_API_KEY, APPLE_SHARED_SECRET, UPSTASH_REDIS_REST_TOKEN, sk-*, postgres://, postgresql://.
- **Pre-commit:** `.pre-commit-config.yaml` runs **gitleaks protect --staged** to block commits with secrets.
- **Docs:** `docs/CLIENT_BUNDLE_SECRET_CHECK.md`, `docs/BUILD_ARTIFACT_SCAN_REPORT.md`, `docs/FOREVER_SECURE_PLAYBOOK.md`.

### 8.5 Logging and telemetry

- **api/client-telemetry.ts** redacts authorization, api_key, bearer, jwt, etc. from headers before storing. **lib/securityBaseline.ts** and **lib/authIntegrity.ts**: never log JWTs or full tokens. No key length or key prefix in responses or logs.

### 8.6 .env and repo

- **.env** and **.env*.local** are gitignored. Never committed. CI checks that no .env file is tracked. See **env-guardrails** job in ci.yml.

---

## 9. Config & environment

- **app.config.js:** Loads .env and .env.local; sets **expo.extra** from env (dev vs prod: EAS_ENV, EAS_BUILD_PROFILE, APP_ENV, NODE_ENV). Dev can use EXPO_PUBLIC_*_DEV or point at deployed API (then prod Supabase). **extra** is allowlisted (see 8.2). Refuses to start dev build if pointing at prod Supabase without pointing at deployed API.
- **Client:** Reads from **Constants.expoConfig.extra** (getEnvVar in lib/getEnvVar.ts). Only supabaseUrl, supabaseAnonKey, EXPO_PUBLIC_API_BASE_URL, eas are in extra. No server secrets.
- **Server:** process.env (Vercel env vars). All API keys and service role only here. See **docs/ENV_AUDIT_REPORT.md**.

---

## 10. Deployment & cron

- **Vercel:** Hosts API (api/*). **vercel.json**: rewrites for /, /admin, /search, /profile, /signin, /:username, etc. **buildCommand** skips build (Vercel compiles TS). **functions:** api/scan.ts maxDuration 60. **crons:** `/api/scan-job` every minute; `/api/scan-reaper` every 10 minutes.
- **Web app:** Expo web export produces **dist/**; served as static (e.g. index.html at /). No sourcemaps in CI (GENERATE_SOURCEMAP=false).
- **Native:** EAS Build (iOS/Android); TestFlight / App Store. See **app.config.js** and **eas.json** if present.

---

## 11. Key files quick reference

| Area | Files |
|------|--------|
| **Entry / shell** | index.js, App.tsx, AppWrapper.tsx, TabNavigator.tsx |
| **Auth** | auth/SimpleAuthContext.tsx, auth/AuthScreens.tsx, lib/supabase.ts |
| **Supabase client** | lib/supabase.ts (app singleton), lib/supabase/client.ts (web), lib/supabaseServerCookies.ts (server cookies) |
| **Scan** | api/scan.ts (processScanJob, handler), api/scan-job.ts, api/scan-worker.ts, api/scan-status.ts, api/sync-scans.ts |
| **Upload / approve** | lib/photoUploadQueue.ts, lib/approveQueue.ts, tabs/ScansTab.tsx |
| **Merge / books** | lib/mergeBooks.ts, lib/dedupBy.ts, services/supabaseSync.ts |
| **Google Books** | services/googleBooksService.ts (client: proxy only), api/google-books.ts (server: cache + key) |
| **Description / metadata** | api/books/enrich-description.ts, api/meta-enrich-worker.ts, lib/enrichDescription.ts, lib/enrichBookMetadata.ts |
| **RLS / migrations** | supabase-migrations/enable-rls-public-tables.sql, database-security-lockdown.sql |
| **Secrets / bundle** | app.config.js (extra allowlist), scripts/ci-bundle-scan.sh, .gitleaks.toml, .github/workflows/ci.yml |
| **Config** | app.config.js, lib/getEnvVar.ts |

---

## Related docs

- **FOREVER_SECURE_PLAYBOOK.md** — Four layers (repo scan, bundle scan, logging, access control).
- **SERVICE_ROLE_NEVER_REACHES_CLIENT.md** — Proof and dependency trace.
- **SUPABASE_KEY_HYGIENE.md** — Anon vs service role usage.
- **CLIENT_BUNDLE_SECRET_CHECK.md** — What’s in the client bundle.
- **BOOK_METADATA_DESCRIPTION_FLOW.md** — Description and metadata flow.
- **ACCEPTANCE_UPLOAD_APPROVE.md** — Upload/approve acceptance and guards.
- **RLS_USER_STATS_AND_TELEMETRY.md** — RLS for user_stats and client_telemetry.
- **ENV_AUDIT_REPORT.md** — Client vs server env.
- **ROTATION_PLAN.md** — Key rotation after leak.
- **LEAKED_SECRETS_REMEDIATION.md** — Steps if secrets were in history.
