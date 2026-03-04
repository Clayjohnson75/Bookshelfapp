# Can any secret reach the client bundle?

## A. What goes into `expo.extra`

**Source:** `app.config.js` (lines 76–111).

The `extra` object is built by an IIFE and returns only:

| Field | Source / fallback | Safe? |
|-------|-------------------|--------|
| **eas** | `{ projectId: "b558ee2d-5af2-481c-82af-669e79311aab" }` | Yes (EAS project id, public) |
| **supabaseUrl** | Dev: `EXPO_PUBLIC_SUPABASE_URL` or `_DEV` or default prod URL. Prod: `EXPO_PUBLIC_SUPABASE_URL` or default. | Yes (public URL) |
| **supabaseAnonKey** | Dev: `EXPO_PUBLIC_SUPABASE_ANON_KEY` or `_DEV` or default JWT. Prod: same. | Yes (anon key is intended public) |
| **EXPO_PUBLIC_API_BASE_URL** | Dev: `EXPO_PUBLIC_API_BASE_URL_DEV` or `EXPO_PUBLIC_API_BASE_URL` or `http://localhost:3000`. Prod: `EXPO_PUBLIC_API_BASE_URL` or `https://www.bookshelfscan.app`. | Yes (API base URL) |

**Not in `extra`:** No `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_BOOKS_API_KEY`, `QSTASH_*`, `UPSTASH_*`, `APPLE_SHARED_SECRET`, `EMAIL_API_KEY`, or any other server-only secret. The comment in config explicitly states: *"SECURITY: OpenAI and Gemini API keys are server-side only (in Vercel env vars)"*.

**Conclusion (A):** Only `supabaseUrl`, `supabaseAnonKey`, `EXPO_PUBLIC_API_BASE_URL`, and `eas` (projectId) are in `expo.extra`. No server-only env is passed into the client.

---

## B. Server-only env in client code paths (hard fail)

**Command run (equivalent):**

```bash
rg -n "(SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY|GEMINI_API_KEY|QSTASH_|UPSTASH_|APPLE_SHARED_SECRET|EMAIL_API_KEY|GOOGLE_BOOKS_API_KEY)" \
  auth components screens tabs contexts App.tsx lib services
```

(For CI we only scan client-entry paths: auth, components, screens, tabs, contexts, App.tsx, AppWrapper.tsx, services — not lib/, since lib is only imported by api/ and not by the client.)

**Result:**

All matches for server-only env names are in **api/** or **scripts/** — not in client entrypoints (auth, components, screens, tabs, contexts, App.tsx). The **lib/** files that reference server-only env are only imported from **api/** and **lib/workers/**; they do not end up in the client bundle.

**services/googleBooksService.ts** is **client-only**: it never references `SUPABASE_SERVICE_ROLE_KEY` or `GOOGLE_BOOKS_API_KEY`. All Google Books requests go through the `/api/google-books` proxy; caching is done by the API.

**CI check:** `scripts/ci-client-secret-check.sh` fails if any server-only env name appears under **client-entry** paths (`auth`, `components`, `screens`, `tabs`, `contexts`, `App.tsx`, `AppWrapper.tsx`, `services`). It does **not** scan `lib/`. No allowlist is needed.

**Conclusion (B):** No server-only env names in client paths. Run the script in CI to catch new references.

---

## C. No `EXPO_PUBLIC_*SERVICE_ROLE` anywhere

**Command run (equivalent):**

```bash
rg -n "EXPO_PUBLIC_.*SERVICE_ROLE" .
```

**Result:** No matches in **code**. The only matches are in **docs** (ENV_AUDIT_REPORT.md, FOREVER_SECURE_PLAYBOOK.md, REPO_SECRET_SCAN_REPORT.md, SERVICE_ROLE_NEVER_REACHES_CLIENT.md) stating that `EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` must not be used and has been removed.

**Code check:** `scripts/reset-dev-passwords.ts` uses only `process.env.SUPABASE_SERVICE_ROLE_KEY` (no EXPO_PUBLIC_ fallback).

**Conclusion (C):** No `EXPO_PUBLIC_*SERVICE_ROLE` exists in the repo. Safe.

---

## Summary

| Check | Status |
|-------|--------|
| A. Only safe fields in expo.extra | OK — supabaseUrl, supabaseAnonKey, EXPO_PUBLIC_API_BASE_URL, eas |
| B. Server-only env in client paths | OK — services/googleBooksService.ts is client-only (proxy only); no server-only env names in client bundle |
| C. No EXPO_PUBLIC_*SERVICE_ROLE | OK — none in code |

No secret **value** reaches the client bundle. Server-only caching lives in api/google-books (and any lib used only by api).
