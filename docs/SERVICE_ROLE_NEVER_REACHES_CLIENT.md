# Proof: service role never reaches the client

This document identifies every usage of `SUPABASE_SERVICE_ROLE_KEY` and `createClient(..., serviceRoleKey)`, classifies each as **server-only** or **shared module imported by client**, and confirms that no client entrypoint can receive the service role **value**. It also provides the dependency trace for the one shared module that references the key.

---

## 1. All usages: classification

### Server-only (api/ routes, server workers, scripts)

These files run only on Vercel (api/) or via Node (scripts/). **No client bundle imports from `api/` or `scripts/`** (verified: no `from '.../api/...'` or `from '.../scripts/...'` in any `.ts`/`.tsx` under app, tabs, screens, components, auth, contexts).

| File | Classification |
|------|----------------|
| api/photo-invariant.ts | Server-only |
| api/get-username.ts | Server-only |
| api/web-signin.ts | Server-only |
| api/scan/[jobId].ts | Server-only |
| api/delete-pending-scan.ts | Server-only |
| api/scan-mark-imported.ts | Server-only |
| api/google-books.ts | Server-only |
| api/audit-event.ts | Server-only |
| api/library-books.ts | Server-only |
| api/public-profile/[username].ts | Server-only |
| api/scan-cancel.ts | Server-only |
| api/set-favorites.ts | Server-only |
| api/scan-status.ts | Server-only |
| api/client-telemetry.ts | Server-only |
| api/scan.ts | Server-only |
| api/admin/check.ts | Server-only |
| api/check-email-exists.ts | Server-only |
| api/books/enrich-batch.ts | Server-only |
| api/books-approve-by-ids.ts | Server-only |
| api/scan-reaper.ts | Server-only |
| api/scan-worker.ts | Server-only |
| api/admin/user-stats.ts | Server-only |
| api/scan-job.ts | Server-only |
| api/register-cover-book.ts | Server-only |
| api/profile/[username].ts | Server-only |
| api/send-password-reset.ts | Server-only |
| api/save-cover.ts | Server-only |
| api/undo-delete.ts | Server-only |
| api/profile/[username]/edit.ts | Server-only |
| api/update-username.ts | Server-only |
| api/update-password.ts | Server-only |
| api/scan-delete.ts | Server-only |
| api/validate-apple-receipt.ts | Server-only |
| api/send-confirmation-email.ts | Server-only |
| api/cover-status.ts | Server-only |
| api/books/enrich-description.ts | Server-only |
| api/sync-scans.ts | Server-only |
| api/delete-library-photo.ts | Server-only |
| api/batch-status.ts | Server-only |
| api/import-guest-pending.ts | Server-only |
| api/repair-dangling-photos.ts | Server-only |
| api/scan-job-patch-photo.ts | Server-only |
| api/password-reset.ts | Server-only |
| api/get-email-by-username.ts | Server-only |
| api/clear-library.ts | Server-only |
| api/library/ask.ts | Server-only |
| api/test.ts | Server-only |
| api/photo-scan-failed.ts | Server-only |
| api/debug/book-counts.ts | Server-only |
| scripts/reset-dev-passwords.ts | Server-only (Node script) |

**Modules that use service role and are only imported by server:**

| File | Importers | Classification |
|------|-----------|----------------|
| lib/coverResolution.ts | api/cover-resolve-worker, api/resolve-covers, api/scan, api/save-cover, api/resolve-cover, api/cover-status, api/scan/[jobId]; lib/workers/metaEnrich | Server-only (no client imports coverResolution) |
| lib/workers/metaEnrich.ts | api/cover-resolve-worker, api/meta-enrich-worker | Server-only |

---

### Shared module imported by client

**Only one module** that reads `SUPABASE_SERVICE_ROLE_KEY` is imported by client code:

| File | Reads service role? | Imported by client? |
|------|---------------------|----------------------|
| **services/googleBooksService.ts** | Yes (guarded: only when `typeof process !== 'undefined' && process.env?.SUPABASE_SERVICE_ROLE_KEY`) | **Yes** — see dependency trace below |

---

## 2. Dependency trace: client → googleBooksService

**Client entrypoints** (what gets bundled for the app):  
`index.js` → `AppWrapper.tsx` → `TabNavigator.tsx` and the tree of screens/tabs/components/contexts they render.

**Trace 1 — ScansTab (static import):**

```
index.js
  → AppWrapper.tsx
    → TabNavigator.tsx
      → ScansTab.tsx
        → import { fetchBookData, saveCoverToStorage, searchMultipleBooks, searchBooksByQuery } from '../services/googleBooksService'
        → require('../services/googleBooksService')  // clearGoogleBooksQueue
```

**Trace 2 — LibraryView (dynamic import):**

```
index.js → AppWrapper → TabNavigator → … → LibraryView.tsx
  → await import('../services/googleBooksService')  // fetchBookData
```

**Trace 3 — BookDetailModal (dynamic import):**

```
index.js → AppWrapper → TabNavigator → … → BookDetailModal.tsx
  → await import('../services/googleBooksService')  // fetchBookData, searchMultipleBooks, saveCoverToStorage
```

So **services/googleBooksService.ts** is in the client dependency graph and is loaded (statically from ScansTab, dynamically from LibraryView and BookDetailModal). That module **does** reference `SUPABASE_SERVICE_ROLE_KEY` and can call `createClient(supabaseUrl, supabaseKey, ...)` when `initSupabaseClient()` runs.

---

## 3. Why the service role value still never reaches the client

In **services/googleBooksService.ts** the service role is only used inside a guarded branch:

```ts
function initSupabaseClient() {
  // ...
  if (typeof process === 'undefined' || !process.env?.SUPABASE_SERVICE_ROLE_KEY) {
    supabaseClient = false;
    return;
  }
  // Only here is the key read and createClient(..., supabaseKey) called:
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && supabaseKey) {
    supabaseClient = createClient(supabaseUrl, supabaseKey, { ... });
  }
}
```

- In the **Expo/React Native client**, `process.env` is populated at **build time** by Metro from `app.config.js` → `expo.extra`. Only `supabaseUrl`, `supabaseAnonKey`, `EXPO_PUBLIC_API_BASE_URL`, and `eas` are in `extra`. **SUPABASE_SERVICE_ROLE_KEY is not there**, so in the client bundle `process.env.SUPABASE_SERVICE_ROLE_KEY` is undefined.
- So in the client runtime the condition `!process.env?.SUPABASE_SERVICE_ROLE_KEY` is true, `initSupabaseClient()` never creates a service-role client, and the **value** of the service role key is never read or used.

**Conclusion:** The **name** `SUPABASE_SERVICE_ROLE_KEY` and the **code path** that would use it exist in the client bundle, but the **value** of the key never does. The service role key is only present in server environment (Vercel, or local Node when running scripts), so it never reaches the client.

---

## 4. Summary table

| Category | Count | Service role value in client? |
|----------|--------|-------------------------------|
| api/* (all routes) | 40+ files | No — api/ not imported by client |
| scripts/* | 1 file | No — scripts not imported by client |
| lib/coverResolution.ts | 1 file | No — only imported by api/ and lib/workers |
| lib/workers/metaEnrich.ts | 1 file | No — only imported by api/ workers |
| services/googleBooksService.ts | 1 file | No — guarded; key not in app.config extra |

**Validation of earlier audit:**  
The earlier claim that “service role is only used server-side” is correct for the **value** of the key: no client environment has `SUPABASE_SERVICE_ROLE_KEY` set, and the only client-imported module that references it (googleBooksService) does not run the code path that reads the key in the client. For defense in depth, you can still refactor so the service-role Supabase client is never created in a module that is bundled for the client (e.g. move server-only cache logic behind an API or into a server-only bundle).
