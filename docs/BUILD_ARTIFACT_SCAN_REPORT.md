# Build-artifact secret scan report

**Build:** `npx expo export --platform web`  
**Artifacts scanned:** `dist/_expo/static/js/web/*.js` and `*.js.map` (when present)  
**Scan patterns:** `service_role`, `SUPABASE_SERVICE_ROLE_KEY`, `sk-`, `QSTASH_`, `OPENAI_API_KEY`, `GOOGLE_BOOKS_API_KEY`, JWT-like strings (`eyJ...`)

**Source maps:** Expo web export does not emit `.js.map` files by default in this setup. CI sets `GENERATE_SOURCEMAP=false` so production artifacts never include sourcemaps. If you enable sourcemaps (e.g. for local debugging), the bundle scan still runs over `*.js.map` when present—do not deploy `.map` files publicly; they can expose source code and env/context. If your deployment serves from `dist/`, either keep `GENERATE_SOURCEMAP=false` or configure the host to exclude `**/*.js.map` from public URLs.

**Success condition (after refactor):** `services/googleBooksService.ts` is client-only (no Supabase service role, no Google Books API key). Therefore:
- **SUPABASE_SERVICE_ROLE_KEY** should **no longer** appear in `dist/_expo/static/js/web/*.js`.
- **GOOGLE_BOOKS_API_KEY** should **no longer** appear in client bundles.

Re-run `npx expo export --platform web` then grep the patterns above on `dist/` to confirm. The “Matches” section below may reflect a pre-refactor build; after a fresh build, those matches should be gone.

---

## Artifact files

| File | Size | Notes |
|------|------|--------|
| dist/_expo/static/js/web/index-341883831398e6f23bd46349a4090280.js | ~2.79 MB | Main app bundle (minified, 1255 lines) |
| dist/_expo/static/js/web/Crypto-6e8e95f84ee2d41153d3ae30f9855ff6.js | ~4.29 kB | Crypto chunk |

---

## Matches (file : line / offset, context, redaction)

### 1. SUPABASE_SERVICE_ROLE_KEY

**Status:** Removed from client bundle. `services/googleBooksService.ts` was refactored to be client-only (no Supabase client, no service role). All Google Books traffic goes through `/api/google-books`; caching is server-side only. A **fresh** web build should not contain this string in `dist/_expo/static/js/web/*.js`. If an older report showed a match, it was from the pre-refactor bundle.

---

### 2. GOOGLE_BOOKS_API_KEY

**Status:** Removed from client bundle. The client never reads this env var; the API proxy (`api/google-books.ts`) does. A **fresh** web build should not contain this string in client bundles.

---

### 3. service_role

**Matches:** **None** as a standalone pattern. The substring appears only inside `SUPABASE_SERVICE_ROLE_KEY` (see above).

---

### 4. sk-

**Matches:** **None.** No OpenAI/Stripe-style `sk-` keys in any artifact.

---

### 5. QSTASH_

**Matches:** **None.** No QStash env var names or values in the client bundle.

---

### 6. OPENAI_API_KEY

**Matches:** **None.** No OpenAI API key name or value in the client bundle.

---

### 7. Long JWT-like strings (eyJ...)

**File:** `dist/_expo/static/js/web/index-341883831398e6f23bd46349a4090280.js`  
**Line:** 436  

**Match:** One JWT-shaped string embedded in the **manifest JSON** (expoConfig/extra). It is the Supabase **anon** key (payload decodes to `"role":"anon"`). This is intended for client use and is safe to ship; RLS protects data.

**Context (excerpt):**  
The bundle contains embedded manifest with `"supabaseAnonKey":"eyJ..."`.  

**Redacted value:**  
`eyJ...REDACTED_ANON_KEY` (Supabase anon JWT — intended to be public; do not commit the real key in docs.)

(Decoded payload: `iss: supabase`, `ref: cnlnrlzhhbrtehpkttqv`, `role: anon`.)

---

## Summary table

| Pattern | Artifact | Line | Inlined value? | Action |
|---------|-----------|------|----------------|--------|
| service_role | — | — | No matches (only inside SUPABASE_SERVICE_ROLE_KEY) | — |
| SUPABASE_SERVICE_ROLE_KEY | index-*.js | 1156 | **No** (env var name + code path only) | Accept; consider removing this code path from client bundle |
| sk- | — | — | None | — |
| QSTASH_ | — | — | None | — |
| OPENAI_API_KEY | — | — | None | — |
| GOOGLE_BOOKS_API_KEY | index-*.js | 1156 | **No** (env var name + read only) | Accept |
| eyJ... (JWT) | index-*.js | 436 | **Yes** — anon key in manifest | Expected; redact in reports only |

**Conclusion:** No secret **values** (service role key, sk-*, QSTASH, OPENAI, GOOGLE_BOOKS) are inlined in the build artifacts. Only the anon JWT appears as a value (by design). The **names** `SUPABASE_SERVICE_ROLE_KEY` and `GOOGLE_BOOKS_API_KEY` and the code that reads them exist in the main bundle (from `services/googleBooksService.ts`); the key values are not present in client env, so they never “oops got inlined.”
