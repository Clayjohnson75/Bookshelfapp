# Bundle secret check (build artifacts scan)

Build command run: `npx expo export --platform web`. Output: `dist/` (main bundle `dist/_expo/static/js/web/index-*.js`).

## Grep results against build output

### 1. service_role / SUPABASE_SERVICE_ROLE

**Matches:** Yes — **string and code path only** (no key value).

- **File:** `dist/_expo/static/js/web/index-341883831398e6f23bd46349a4090280.js` (minified).
- **What’s in the bundle:** The **name** `SUPABASE_SERVICE_ROLE_KEY` and code that does `process.env?.SUPABASE_SERVICE_ROLE_KEY` and `createClient(url, s, { auth: { persistSession: !1, autoRefreshToken: !1 } })`. This comes from `services/googleBooksService.ts`, which has a server-side branch that creates a Supabase client with the service role key when `process.env.SUPABASE_SERVICE_ROLE_KEY` is set.
- **Actual key value:** Not present. In the browser, `process.env` does not contain server secrets, so the key value is not shipped. Risk is if the same bundle were ever built or run in an context where that env was set.
- **Recommendation:** Prefer not shipping this code path in the client at all. Refactor so the service-role Supabase client is only used in server/API code (e.g. move cache logic behind an API or use a dynamic import that is never resolved in the client bundle).

---

### 2. OPENAI_API_KEY / GEMINI_API_KEY / GOOGLE_BOOKS_API_KEY

**Matches:** Yes — **env var name and read logic** (no key values).

- **File:** Same bundle as above.
- **What’s in the bundle:** The string `GOOGLE_BOOKS_API_KEY` and code like `r('GOOGLE_BOOKS_API_KEY')` (reading from `process.env`). Used for optional direct Google Books calls when not using the proxy. No literal key value is in the bundle; client builds don’t get these from `expo.extra`.
- **Recommendation:** Acceptable as long as no secret is ever added to `expo.extra` or inlined for client. Optional: strip or tree-shake this branch in client builds so the env var name isn’t in the bundle.

---

### 3. QSTASH_TOKEN / APPLE_SHARED_SECRET / EMAIL_API_KEY

**Matches:** No. None of these strings or patterns appear in the scanned bundle.

---

### 4. sk- (OpenAI/Stripe-style keys)

**Matches:** No. No `sk-`-prefixed literal keys in the bundle.

---

### 5. JWT (eyJ...)

**Matches:** 2 occurrences of a JWT-shaped string.

- **Value:** `eyJ...REDACTED_ANON_KEY` (Supabase anon key — do not commit the real JWT in docs.)
- **Interpretation:** Supabase **anon** key (payload contains `"role":"anon"`). Intended to be public; RLS protects data.

---

## Summary

| Check                         | Result | Notes |
|------------------------------|--------|--------|
| service_role key **value**   | Not in bundle | Only env var name + code path present. |
| SUPABASE_SERVICE_ROLE_KEY **name/code** | In bundle | googleBooksService server branch; recommend moving out of client bundle. |
| OPENAI/GEMINI/GOOGLE key **values** | Not in bundle | Only GOOGLE_BOOKS_API_KEY name + read logic. |
| QSTASH / Apple / Email       | Not in bundle | No matches. |
| sk-* literals                | Not in bundle | No matches. |
| JWT (eyJ...)                 | 2 in bundle   | Anon key only (expected). |

**Conclusion:** No secret **values** were found in the web build output. The only sensitive **references** are the SUPABASE_SERVICE_ROLE_KEY env name and the code path that would use it; that path should not run in the browser and the key is not inlined. Recommended follow-up: remove the service-role Supabase client path from the client bundle (e.g. API-only or conditional server bundle).
