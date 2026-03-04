# Supabase key hygiene and RLS dependencies

## Where the **anon** key is used

The anon key is **intended** for client use. It is only safe when RLS policies correctly restrict access to the caller’s data.

| Location | Purpose |
|----------|---------|
| **lib/supabase.ts** | Single app-wide Supabase client for the Expo app. Reads `supabaseUrl` and `supabaseAnonKey` from `getEnvVar()` (expo.extra). Used by all client code (tabs, screens, auth, contexts). |
| **lib/supabase/client.ts** | Browser client for web (createBrowserClient) using anon key. |
| **lib/supabaseBrowser.ts** | Server-rendered/web path: creates client with anon key from env (EXPO_PUBLIC_SUPABASE_* or SUPABASE_*). |
| **lib/supabaseServerCookies.ts** | Server-side (API/SSR) session handling: creates Supabase client with anon key and cookie-based session. |
| **api/signin.ts** | Auth: creates anon client to perform sign-in. |
| **api/confirm-email.ts** | Auth: anon client for confirmation. |
| **api/confirm-email-api.ts** | Auth: anon client. |
| **api/check-subscription.ts** | Creates anon client for subscription check (RLS limits to own rows). |
| **api/refresh-token.ts** | Auth: anon client for token refresh. |
| **api/update-password.ts** | Auth: anon client for password update and recovery flow. |
| **api/web-signin.ts** | Web auth: anon client for sign-in; service role used only for admin steps after. |
| **api/library/ask.ts** | Creates anon client (RLS constrains to user’s data). |

All of the above are either (1) client bundle (lib/supabase.ts, lib/supabase/client.ts) or (2) server-side API routes that use the anon key only for auth or for operations that RLS restricts to the authenticated user.

---

## Where the **service_role** key is used

The service role key **must never** appear in repo history, client code, or client runtime config. It must only be used in server-side code (Vercel API, Edge Functions, or scripts) with the key coming from environment variables (e.g. Vercel env or `.env` not committed).

| Location | Purpose |
|----------|---------|
| **api/batch-status.ts** | Admin client for batch status. |
| **api/books/enrich-batch.ts** | Enrichment with service role. |
| **api/books/enrich-description.ts** | Enrichment. |
| **api/books-approve-by-ids.ts** | Approve books. |
| **api/check-email-exists.ts** | Admin lookup. |
| **api/client-telemetry.ts** | Write telemetry (server-side). |
| **api/cover-status.ts** | Cover resolution status; also uses getSupabase(). |
| **api/delete-library-photo.ts** | Delete photo and cascade. |
| **api/delete-pending-scan.ts** | Delete scan. |
| **api/get-email-by-username.ts** | Admin lookup. |
| **api/get-username.ts** | Admin lookup. |
| **api/import-guest-pending.ts** | Import. |
| **api/library-books.ts** | Library books. |
| **api/password-reset.ts** | Password reset flow (admin steps). |
| **api/profile/[username].ts** | Profile page (admin for cross-user data). |
| **api/profile/[username]/edit.ts** | Profile edit. |
| **api/register-cover-book.ts** | Cover registration. |
| **api/repair-dangling-photos.ts** | Repair. |
| **api/resolve-cover.ts** | Uses getSupabase() (service role). |
| **api/save-cover.ts** | Save cover. |
| **api/scan-cancel.ts** | Cancel scan. |
| **api/scan-delete.ts** | Delete scan. |
| **api/scan-job.ts** | Scan job lifecycle (multiple createClient(..., serviceKey)). |
| **api/scan-job-patch-photo.ts** | Patch scan job photo_id. |
| **api/scan-mark-imported.ts** | Mark imported. |
| **api/scan-reaper.ts** | Reaper. |
| **api/scan-worker.ts** | Scan worker. |
| **api/scan.ts** | Main scan API. |
| **api/scan/[jobId].ts** | Job status. |
| **api/send-confirmation-email.ts** | Confirmation email (admin). |
| **api/send-password-reset.ts** | Password reset (admin). |
| **api/set-favorites.ts** | Favorites. |
| **api/sync-scans.ts** | Sync. |
| **api/undo-delete.ts** | Undo delete. |
| **api/update-username.ts** | Username update. |
| **api/validate-apple-receipt.ts** | Apple IAP. |
| **api/audit-event.ts** | Audit. |
| **api/admin/check.ts** | Admin check. |
| **api/admin/user-stats.ts** | Admin user stats (uses private schema). |
| **api/photo-invariant.ts** | Photo invariant diagnostic. |
| **api/debug/book-counts.ts** | Debug. |
| **api/test.ts** | Test. |
| **lib/coverResolution.ts** | `getSupabase()`: service role client for cover resolution (used by api/cover-status, api/resolve-cover, workers). |
| **lib/workers/metaEnrich.ts** | Meta enrich worker (service role). |
| **services/googleBooksService.ts** | When `SUPABASE_SERVICE_ROLE_KEY` is set (server path only): creates service role client for cache. |
| **scripts/reset-dev-passwords.ts** | Dev script: must use only `SUPABASE_SERVICE_ROLE_KEY` (remove EXPO_PUBLIC_ fallback). |

**Verification:** No file under `auth/`, `components/`, `screens/`, `tabs/`, or `contexts/` imports or uses the service role key. All service role usage is under `api/`, `lib/` (coverResolution, workers), `services/` (server path), or `scripts/`.

---

## RLS dependencies (anon key is safe only if RLS is correct)

Access with the **anon** key is constrained by Row Level Security. The following should hold:

1. **Tables the client touches with anon:**  
   `profiles`, `books`, `photos`, `scan_jobs`, `client_telemetry`, `book_cover_cache`, `cover_aliases`, `user_stats`, `cover_resolutions` (read only as needed), etc.  
   Each of these must have RLS enabled and policies that restrict rows to the authenticated user (e.g. `auth.uid() = user_id` or equivalent).

2. **Service role bypasses RLS:**  
   All api/* and workers that use the service role key can read/write according to their logic; they do not rely on RLS for isolation. Isolation is enforced by API auth (e.g. JWT, session) and then server code using the service role.

3. **Private schema:**  
   Views like `private.user_activity_stats` and `private.user_stats_with_usernames` are not accessible to anon; they are used only by server code with service role (or a role that has access to `private`).

4. **Initplan for auth.uid():**  
   RLS policies should use `(select auth.uid())` so the planner sees a stable value and does not re-evaluate per row in a way that could leak data.

**Summary:** Anon key is used only in client and in server auth/RLS-scoped paths. Service role is used only in server-side API/workers/scripts. Ensure RLS is enabled and correct on all tables that anon can access; then anon key exposure is acceptable by design.
