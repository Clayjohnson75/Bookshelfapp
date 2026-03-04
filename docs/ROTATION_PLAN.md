# Key rotation plan (if you suspect any key leaked)

**Rule: any suspected leak = rotate immediately.** Do not wait for confirmation. Rotate first, then investigate.

If anything real leaked even once, rotation is the right move. This document lists every key/secret used in the project, where it’s stored, and how to rotate each one. For each: **revoke or rotate the old key → deploy the new key → confirm the old key stops working.**

---

## 1. Supabase

| Key | Purpose | Where stored | Blast radius | Rotation steps |
|-----|---------|--------------|--------------|----------------|
| **Anon key** | Client-safe; RLS enforces access | Local: `.env` (EXPO_PUBLIC_SUPABASE_ANON_KEY). Vercel: env vars. EAS: secrets or env in build. app.config.js can hardcode fallback (prefer env). | All data allowed by RLS (per-user rows only if policies correct). Leak = anyone can act as unauthenticated or as any user if JWT forged (rotate anon + fix RLS). | 1. Supabase Dashboard → Project Settings → API → Create new anon key (or use “Regenerate” if available). 2. Update Vercel env vars and EAS secrets with new key. 3. Update local `.env` and any app.config fallback. 4. Redeploy API (Vercel) and rebuild/redeploy app (EAS). 5. Revoke/delete old anon key in Dashboard. 6. Confirm: old key returns 401/invalid; new key works. |
| **Service role key** | Server-only; bypasses RLS | Local: `.env` (SUPABASE_SERVICE_ROLE_KEY only, never EXPO_PUBLIC_). Vercel: Environment Variables. Scripts: env only. | **Full DB and Auth** (read/write all tables, manage users). Leak = total compromise until rotated. | 1. Supabase Dashboard → Project Settings → API → Regenerate service_role key. 2. **Immediately** set new value in Vercel (Production, Preview, Development). 3. Update local `.env` for scripts. 4. Redeploy all Vercel functions so they pick up new env. 5. Confirm: old key no longer works (Supabase invalidates previous key on regenerate). 6. Never use service role in client or in repo. |

**Where used:** See [docs/SUPABASE_KEY_HYGIENE.md](SUPABASE_KEY_HYGIENE.md). Anon = client + server auth routes. Service role = api/*, lib/coverResolution, workers, scripts only.

---

## 2. OpenAI

| Key | Purpose | Where stored | Blast radius | Rotation steps |
|-----|---------|--------------|--------------|----------------|
| **OPENAI_API_KEY** | Chat/completion (scan, library/ask, auto-sort, avatar) | Local: `.env`. Vercel: env vars. | API usage / cost; no direct DB access. | 1. OpenAI platform → API keys → Revoke old key, create new key. 2. Set new key in Vercel env and local `.env`. 3. Redeploy Vercel. 4. Confirm: requests with old key fail; new key works. |

---

## 3. Google (Gemini + Books)

| Key | Purpose | Where stored | Blast radius | Rotation steps |
|-----|---------|--------------|--------------|----------------|
| **GEMINI_API_KEY** | Scan / book detection (api/scan.ts) | Local: `.env`. Vercel: env vars. | API usage / cost; no direct DB access. | 1. Google AI Studio / Cloud Console → Create new API key or disable old. 2. Update Vercel and local `.env`. 3. Redeploy Vercel. 4. Confirm old key rejected, new works. |
| **GOOGLE_BOOKS_API_KEY** | Book metadata (api/google-books, enrich, scan) | Local: `.env`. Vercel: env vars. | API usage / cost; no direct DB access. | 1. Google Cloud Console → APIs & Services → Credentials → Create new key or restrict/regenerate. 2. Update Vercel and local `.env`. 3. Redeploy Vercel. 4. Confirm old key returns 403; new works. |

---

## 4. QStash (Upstash)

| Key | Purpose | Where stored | Blast radius | Rotation steps |
|-----|---------|--------------|--------------|----------------|
| **QSTASH_TOKEN** | Publish messages to scan-worker, cover-resolve-worker | Local: `.env`. Vercel: env vars. | Can enqueue jobs (scan, cover resolve); no direct DB. | 1. Upstash Console → QStash → Create new token or revoke old. 2. Update Vercel and local `.env`. 3. Redeploy Vercel. 4. Confirm old token rejected on publish. |
| **QSTASH_CURRENT_SIGNING_KEY**, **QSTASH_NEXT_SIGNING_KEY** | Verify webhook signatures (scan-worker, cover-resolve-worker) | Local: `.env`. Vercel: env vars. | Leak could allow forged webhook calls (workers run with service role). | 1. Upstash Console → QStash → Signing keys. Rotate: set new as current, old as next, then phase out. 2. Update both in Vercel and local `.env`. 3. Redeploy. 4. Confirm invalid signatures rejected. |

---

## 5. Resend (email)

| Key | Purpose | Where stored | Blast radius | Rotation steps |
|-----|---------|--------------|--------------|----------------|
| **EMAIL_API_KEY** | Send password reset, confirmation emails | Local: `.env`. Vercel: env vars. | Send email as your domain; no direct DB. | 1. Resend Dashboard → API Keys → Create new, revoke old. 2. Update Vercel and local `.env`. 3. Redeploy. 4. Confirm old key fails; new key sends. |
| **EMAIL_FROM** | Sender address (optional) | Env only. | — | No rotation; update env if you change domain. |

---

## 6. Upstash Redis

| Key | Purpose | Where stored | Blast radius | Rotation steps |
|-----|---------|--------------|--------------|----------------|
| **UPSTASH_REDIS_REST_URL**, **UPSTASH_REDIS_REST_TOKEN** | Rate limiting (cover, etc.) | Local: `.env`. Vercel: env vars. | Rate-limit state; no app data. | 1. Upstash Console → Redis → Rest API → Reset token or create new database. 2. Update URL/token in Vercel and local `.env`. 3. Redeploy. 4. Confirm old token fails; new works. |

---

## 7. Apple (IAP)

| Key | Purpose | Where stored | Blast radius | Rotation steps |
|-----|---------|--------------|--------------|----------------|
| **APPLE_SHARED_SECRET** | Server-side receipt validation (api/validate-apple-receipt) | Local: `.env`. Vercel: env vars. Stored in App Store Connect. | IAP validation; leak could allow forged receipts. | 1. App Store Connect → App → App Information → Manage App-Specific Shared Secret → Generate new or revoke. 2. Update Vercel and local `.env`. 3. Redeploy. 4. Confirm old secret fails validation; new works. |

---

## 8. Other env (no secret value)

| Item | Purpose | Where stored | Rotation |
|------|---------|--------------|----------|
| **COVER_RESOLVE_WORKER_URL** | URL of cover worker | Env. | No key; change URL if you move the endpoint. |
| **ENABLE_PRO_FOR_EVERYONE** | Feature flag | Env. | Toggle true/false as needed. |
| **SUPABASE_URL** / **EXPO_PUBLIC_SUPABASE_URL** | Supabase project URL | Env, app.config extra. | Only change if you migrate to a new Supabase project. |
| **EXPO_PUBLIC_API_BASE_URL** | API base URL | Env, app.config extra. | Change when you change backend URL. |

---

## Summary: where secrets live

- **Local:** `.env` and `.env.local` (gitignored). Never commit.
- **CI (GitHub Actions):** Only `GITHUB_TOKEN` is used by gitleaks; no project secrets in CI.
- **Hosting (Vercel):** All server keys (Supabase service role, OpenAI, Gemini, Google Books, QStash, Resend, Upstash Redis, Apple) in Project → Settings → Environment Variables (Production / Preview / Development as needed).
- **EAS (Expo Application Services):** For native builds, use EAS Secrets or build env for anything the app needs at runtime (e.g. EXPO_PUBLIC_*). Never put service role or other server-only keys in EAS.

**Order of operations after a leak:** (1) Rotate the leaked key at the provider. (2) Update Vercel (and EAS/local) with the new value. (3) Redeploy so running code uses the new key. (4) Confirm the old key no longer works. (5) If the key was in git history, consider rotation already done and avoid re-adding it; use gitleaks and pre-commit to prevent future commits.
